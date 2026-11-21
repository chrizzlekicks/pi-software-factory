import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import * as agentCore from "@earendil-works/pi-agent-core";
import * as ai from "@earendil-works/pi-ai";
import * as codingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import * as typebox from "typebox";
import * as typeboxCompile from "typebox/compile";
import * as typeboxValue from "typebox/value";
import { Value } from "typebox/value";

import { loadSubagents, PiAgents, roles } from "../src/agents.ts";
import { validatePlan } from "../src/git.ts";

test("planner uses the trusted architect", () => {
  assert.equal(roles.planner?.agent, "architect");
  assert.equal(roles.planner?.readOnly, false);
});

test("planner schema rejects empty required plan lists before factory validation", () => {
  const plan = {
    summary: "Change app",
    tasks: ["Change app"],
    files: ["app.txt"],
    risks: [],
    dependencies: [],
    verification: [{ command: "npm", args: ["test"], purpose: "Test" }],
  };
  const schema = roles.planner?.schema as Parameters<typeof Value.Check>[0];
  assert.equal(Value.Check(schema, plan), true);
  assert.deepEqual(validatePlan(plan), plan);
  for (const field of ["tasks", "files", "verification"] as const) {
    const invalid = { ...plan, [field]: [] };
    assert.equal(Value.Check(schema, invalid), false, field);
    assert.throws(() => validatePlan(invalid), /Invalid plan/);
  }
});

function fixture(plannerTools?: {
  effectiveAllowlist: string[];
  fanoutAuthorized: boolean;
  configuredExtensions: string[];
}) {
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const events = {
    on(name: string, fn: (p: unknown) => void) {
      const set = handlers.get(name) ?? new Set();
      handlers.set(name, set);
      set.add(fn);
      return () => set.delete(fn);
    },

    emit(name: string, p: unknown) {
      for (const fn of handlers.get(name) ?? []) {
        fn(p);
      }
    },
  };
  const ceilings: unknown[] = [];
  let disposed = 0,
    valid = true,
    owner = true;
  events.on("subagents:rpc:v1:request", (p) => {
    if (owner && p && typeof p === "object" && "requestId" in p) {
      events.emit(`subagents:rpc:v1:reply:${p.requestId}`, {
        version: 1,
        requestId: p.requestId,
        method: "ping",
        success: true,
        data: { version: 1 },
      });
    }
  });
  const delegation = {
    SUBAGENT_DELEGATION_REQUEST_EVENT: "request",
    SUBAGENT_DELEGATION_RESPONSE_EVENT: "response",
    SUBAGENT_DELEGATION_UPDATE_EVENT: "update",
    SUBAGENT_DELEGATION_CANCEL_EVENT: "cancel",
  };
  const api = {
    delegation,
    ceiling: {
      registerSubagentCapabilityCeiling: (input: unknown) => {
        ceilings.push(input);
        return {
          dispose() {
            disposed++;
          },
        };
      },
      resolveCurrentSubagentCapabilityCeiling: () => ({}),
    },
    preflight: {
      resolveSubagentLaunchContract: async () =>
        valid
          ? {
              ok: true,
              contract: {
                model: "p/m",
                skills: { resolved: [] },
                tools: plannerTools ?? { effectiveAllowlist: ["read"] },
              },
            }
          : { ok: false, message: "missing" },
    },
  };
  const sessionManager = {
    getSessionId: () => "session",
    getSessionFile: () => undefined,
  } satisfies Pick<ExtensionContext["sessionManager"], "getSessionId" | "getSessionFile">;
  const ctx = {
    model: undefined,
    sessionManager,
    isProjectTrusted: () => true,
    modelRegistry: { getAvailable: () => [{ provider: "p", id: "m" }], getAll: () => [] },
    scopedModels: [],
  } satisfies Pick<ExtensionContext, "model" | "isProjectTrusted" | "scopedModels"> & {
    sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getSessionFile">;
    modelRegistry: {
      getAvailable(): Pick<
        ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>[number],
        "provider" | "id"
      >[];
      getAll(): Pick<ReturnType<ExtensionContext["modelRegistry"]["getAll"]>[number], "provider">[];
    };
  };
  const pi = { events } satisfies Pick<ExtensionAPI, "events">;
  return {
    events,
    ceilings,
    // The fake host supplies only members exercised by these tests.
    agents: new PiAgents(pi as unknown as ExtensionAPI, ctx as unknown as ExtensionContext, api),
    disable: () => {
      valid = false;
    },
    disableOwner: () => {
      owner = false;
    },
    disposed: () => disposed,
  };
}
const id = { requestId: "r", ownerRunId: "o", nodeId: "n" };
test("delegation correlates all identity fields and accepts structured terminal result", async () => {
  const f = fixture();
  let request: unknown;
  f.events.on("request", (p) => {
    request = p;
    f.events.emit("response", { ...id, nodeId: "other", status: "failed" });
    queueMicrotask(() =>
      f.events.emit("response", {
        ...id,
        status: "completed",
        result: { kind: "structured", value: { ok: true } },
      }),
    );
  });
  assert.deepEqual(await f.agents.run("worker", "work", "/tmp", id), { ok: true });
  assert.ok(request && typeof request === "object" && "agent" in request);
  assert.equal(request.agent, "worker");
  assert.equal(f.disposed(), 1);
});

test("terminal failure rejects and cancellation waits for terminal response", async () => {
  const f = fixture();
  const abort = new AbortController();
  let cancelled = false;
  f.events.on("request", () => abort.abort());
  f.events.on("cancel", (p) => {
    assert.deepEqual(p, id);
    cancelled = true;
    queueMicrotask(() =>
      f.events.emit("response", { ...id, status: "cancelled", error: "stopped" }),
    );
  });
  await assert.rejects(f.agents.run("worker", "work", "/tmp", id, abort.signal), /cancelled/);
  assert.equal(cancelled, true);
  assert.equal(f.disposed(), 1);
});

test("required launch preflight failure prevents delegation", async () => {
  const f = fixture();
  f.disable();
  let called = false;
  f.events.on("request", () => {
    called = true;
  });
  await assert.rejects(f.agents.run("worker", "work", "/tmp", id), /unavailable/);
  assert.equal(called, false);
  assert.equal(f.disposed(), 1);
});

test("preflight accepts recognized thinking suffix and passes the delegation schema", async () => {
  const f = fixture();
  let seen: { outputSchema: unknown } | undefined;
  f.agents.api.preflight.resolveSubagentLaunchContract = async (input: {
    outputSchema: unknown;
  }) => {
    seen = input;
    return {
      ok: true,
      contract: {
        model: "p/m:high",
        skills: { resolved: [] },
        tools: { effectiveAllowlist: ["read"] },
      },
    };
  };
  f.events.on("request", (p) => {
    assert.ok(seen);
    assert.ok(p && typeof p === "object" && "result" in p);
    assert.ok(p.result && typeof p.result === "object" && "schema" in p.result);
    assert.deepEqual(seen.outputSchema, p.result.schema);
    queueMicrotask(() =>
      f.events.emit("response", {
        ...id,
        status: "completed",
        result: { kind: "structured", value: {} },
      }),
    );
  });
  await f.agents.run("quality", "review", "/tmp", id);
  f.agents.api.preflight.resolveSubagentLaunchContract = async () => ({
    ok: true,
    contract: {
      model: "p/m:bogus",
      skills: { resolved: [] },
      tools: { effectiveAllowlist: ["read"] },
    },
  });
  await assert.rejects(f.agents.run("quality", "review", "/tmp", id), /model unavailable/);
});

test("read-only preflight permits structured output but rejects unexpected tools", async () => {
  const f = fixture();
  let tools = ["read", "grep", "find", "ls", "structured_output"];
  f.agents.api.preflight.resolveSubagentLaunchContract = async () => ({
    ok: true,
    contract: { model: "p/m", skills: { resolved: [] }, tools: { effectiveAllowlist: tools } },
  });
  f.events.on("request", () =>
    queueMicrotask(() =>
      f.events.emit("response", {
        ...id,
        status: "completed",
        result: { kind: "structured", value: {} },
      }),
    ),
  );
  await f.agents.run("quality", "review", "/tmp", id);
  tools = [...tools, "bash", "write", "contact_supervisor"];
  await assert.rejects(
    f.agents.run("quality", "review", "/tmp", id),
    /Cannot enforce read-only agent tools: bash, write, contact_supervisor/,
  );
});

test("an abort during launch preflight prevents delegation", async () => {
  const f = fixture();
  const abort = new AbortController();
  let called = false;
  f.agents.api.preflight.resolveSubagentLaunchContract = async () => {
    abort.abort();
    return {
      ok: true,
      contract: {
        model: "p/m:low",
        skills: { resolved: [] },
        tools: { effectiveAllowlist: ["read"] },
      },
    };
  };
  f.events.on("request", () => {
    called = true;
  });
  await assert.rejects(f.agents.run("quality", "review", "/tmp", id, abort.signal), /cancelled/i);
  assert.equal(called, false);
});

test("inactive owner fails before dispatch", async () => {
  const f = fixture();
  f.disableOwner();
  let called = false;
  f.events.on("request", () => {
    called = true;
  });
  await assert.rejects(f.agents.run("quality", "review", "/tmp", id), /owner unavailable/);
  assert.equal(called, false);
});

test("delegation ignores malformed terminal events", async () => {
  const f = fixture();
  f.events.on("request", () => {
    f.events.emit("response", null);
    f.events.emit("response", { ...id, status: "completed", result: null });
  });
  await assert.rejects(f.agents.run("worker", "work", "/tmp", id), /no structured result/);
});

test("planner preflight accepts an unverified extension without proving web activation", async () => {
  const f = fixture({
    effectiveAllowlist: ["subagent", "web_enable"],
    fanoutAuthorized: true,
    configuredExtensions: ["/trusted/web.js"],
  });
  await assert.rejects(
    f.agents.run("planner", "plan", "/tmp", id, AbortSignal.abort()),
    /cancelled/i,
  );
});

test("planner ceiling grants scout, researcher and web without changing reviewer policy", async () => {
  const f = fixture();
  await assert.rejects(f.agents.run("planner", "plan", "/tmp", id), /Architect requires/);
  await assert.rejects(
    f.agents.run("quality", "review", "/tmp", id, AbortSignal.abort()),
    /cancelled/i,
  );
  const [planner, reviewer] = f.ceilings as {
    ceiling: { allowedAgents: string[]; allowedTools: string[]; denyExtensions: boolean };
  }[];
  assert.deepEqual(planner?.ceiling.allowedAgents, ["architect", "scout", "researcher"]);
  for (const tool of [
    "subagent",
    "web_enable",
    "web_search",
    "fetch_content",
    "get_search_content",
    "bash",
    "write",
  ]) {
    assert.ok(planner?.ceiling.allowedTools.includes(tool), tool);
  }
  assert.equal(planner?.ceiling.denyExtensions, false);
  assert.deepEqual(reviewer?.ceiling.allowedTools, ["read", "grep", "find", "ls"]);
  assert.equal(reviewer?.ceiling.denyExtensions, true);
});

test("installed pi-subagents resolves architect, scout and researcher contracts under planner ceiling", async (t) => {
  const root =
    process.env.PI_FACTORY_SUBAGENTS_PATH ??
    join(homedir(), ".pi/agent/npm/node_modules/pi-subagents");
  const web = join(homedir(), ".pi/agent/npm/node_modules/pi-web-access/dist/index.js");
  if (!existsSync(join(root, "package.json")) || !existsSync(web)) {
    return t.skip("installed integration packages unavailable");
  }
  const cwd = mkdtempSync(join(tmpdir(), "factory-contract-"));
  try {
    mkdirSync(join(cwd, ".pi/agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi/agents/architect.md"),
      `---\nname: architect\ndescription: contract test\ntools: subagent, web_enable, web_search, source_check, fetch_content, get_search_content\nsubagentOnlyExtensions: ${web}\n---\nPlan.\n`,
    );
    writeFileSync(
      join(cwd, ".pi/settings.json"),
      JSON.stringify({
        subagents: {
          agentOverrides: {
            researcher: {
              tools: [
                "read",
                "write",
                "web_enable",
                "web_search",
                "source_check",
                "fetch_content",
                "get_search_content",
              ],
              subagentOnlyExtensions: [web],
            },
          },
        },
      }),
    );
    const api = await loadSubagents({
      "@earendil-works/pi-agent-core": agentCore,
      "@earendil-works/pi-ai": ai,
      "@earendil-works/pi-coding-agent": codingAgent,
      "@earendil-works/pi-tui": tui,
      typebox,
      "typebox/compile": typeboxCompile,
      "typebox/value": typeboxValue,
    });
    const ceiling = {
      allowedAgents: ["architect", "scout", "researcher"],
      allowedTools: [
        "read",
        "grep",
        "find",
        "ls",
        "bash",
        "write",
        "subagent",
        "web_enable",
        "web_search",
        "source_check",
        "fetch_content",
        "get_search_content",
      ],
      denyExtensions: false,
    };
    const input = {
      cwd,
      context: "fresh",
      projectTrusted: true,
      parentModel: { provider: "test", id: "test" },
      intercomBridge: { mode: "off" },
      capabilityCeiling: ceiling,
    };
    const architect = await api.preflight.resolveSubagentLaunchContract({
      ...input,
      agent: "architect",
      outputSchema: roles.planner?.schema,
    });
    assert.equal(architect.ok, true, architect.message);
    assert.equal(architect.contract.tools.fanoutAuthorized, true);
    assert.ok(architect.contract.tools.configuredExtensions.includes(web));
    for (const name of [
      "subagent",
      "web_enable",
      "web_search",
      "fetch_content",
      "get_search_content",
    ]) {
      assert.ok(architect.contract.tools.effectiveAllowlist.includes(name), name);
    }
    const scout = await api.preflight.resolveSubagentLaunchContract({ ...input, agent: "scout" });
    assert.equal(scout.ok, true, scout.message);
    assert.ok(scout.contract.tools.effectiveAllowlist.includes("bash"));
    assert.ok(scout.contract.tools.effectiveAllowlist.includes("write"));
    const researcher = await api.preflight.resolveSubagentLaunchContract({
      ...input,
      agent: "researcher",
    });
    assert.equal(researcher.ok, true, researcher.message);
    assert.equal(researcher.contract.agent.source, "builtin");
    assert.equal(researcher.contract.agent.filePath, join(root, "agents/researcher.md"));
    assert.ok(researcher.contract.tools.configuredExtensions.includes(web));
    for (const name of [
      "web_enable",
      "web_search",
      "source_check",
      "fetch_content",
      "get_search_content",
    ]) {
      assert.ok(researcher.contract.tools.effectiveAllowlist.includes(name), name);
    }
    const worker = await api.preflight.resolveSubagentLaunchContract({ ...input, agent: "worker" });
    assert.equal(worker.ok, false);
    assert.equal(worker.code, "restricted_agent");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
