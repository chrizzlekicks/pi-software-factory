import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { PiAgents } from "../src/agents.ts";

function fixture() {
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
      registerSubagentCapabilityCeiling: () => ({
        dispose() {
          disposed++;
        },
      }),
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
                tools: { effectiveAllowlist: ["read"] },
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
