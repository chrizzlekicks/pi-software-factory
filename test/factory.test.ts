import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
  mkdirSync as makeDirectory,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { Value } from "typebox/value";

import { roles } from "../src/agents.ts";
import { Factory } from "../src/controller.ts";
import { GitHubDelivery as PreflightDelivery } from "../src/delivery.ts";
import { Git } from "../src/git.ts";
import { status } from "../src/index.ts";
import { Store } from "../src/state.ts";
import type { Run, Evidence } from "../src/state.ts";

type CommandContext = { ui: { notify(message: string): void } };
type CommandHandler = (args: string, ctx: CommandContext) => Promise<void>;
type Command = { description: string; handler: CommandHandler };
type EvidenceFinding = { id: string; blocking: boolean; evidence: string };

function present<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- Wait for the detached command to reach a durable boundary.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for factory command");
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function fixture(t: TestContext, failures = 0) {
  const root = mkdtempSync(join(tmpdir(), "factory-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  git(root, "init", "-b", "main", repo);
  git(repo, "config", "user.name", "Factory Test");
  git(repo, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, "app.txt"), "old");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  const calls: string[] = [];
  let testRuns = 0;
  let repairs = 0;
  const plan = {
    summary: "Change app",
    tasks: ["Change app.txt"],
    files: ["app.txt"],
    risks: ["None"],
    dependencies: [],
    verification: [
      { command: process.execPath, args: ["-e", "process.exit(0)"], purpose: "Smoke" },
    ],
  };
  const agents = {
    async preflight() {},

    async run(role: string, task: string, cwd: string) {
      calls.push(role);
      if (role === "planner") {
        return plan;
      }
      if (role === "challenger") {
        return { approved: true, findings: [] };
      }
      if (role === "worker") {
        writeFileSync(join(cwd, "app.txt"), "new");
        return { summary: "Done", scopeChange: "" };
      }
      if (role === "repair") {
        repairs++;
        writeFileSync(join(cwd, "app.txt"), "fixed" + repairs);
        return { summary: "Fixed", scopeChange: "" };
      }
      if (role === "tester") {
        return { passed: ++testRuns > failures, summary: "Tests", commands: plan.verification };
      }
      if (role === "triage") {
        const input = task.split("Consolidate these findings: ")[1]?.split(". Confirm")[0];
        const findings = JSON.parse(input ?? "[]") as EvidenceFinding[];
        return {
          findings: findings.map((f) => ({ ...f, confirmed: true })),
          complete: true,
          completionEvidence: "Request assessed against changes and checks",
          commitSubject: "fix: update app",
        };
      }
      if (role === "docs") {
        return { summary: "Docs current", changes: false };
      }
      return {
        summary: "Clean",
        findings: [],
        coverage: [
          ...new Set(
            [
              ...git(cwd, "diff", "--name-only", "HEAD").split("\n"),
              ...git(cwd, "ls-files", "--others", "--exclude-standard").split("\n"),
            ].filter(Boolean),
          ),
        ],
      };
    },
  };
  const delivery = {
    async preflight() {
      return { repo: "example/repo", base: "main", remote: "https://github.com/example/repo.git" };
    },

    async deliver(s: Run) {
      assert.ok(s.revision);
      return { url: "https://github.com/example/repo/pull/1", head: s.revision, draft: true };
    },
  };
  const store = new Store(join(root, "state"));
  t.after(() => {
    if (existsSync(store.dir)) {
      store.close();
    }
  });
  const factory = new Factory(store, new Git(repo), agents, delivery);
  return { root, repo, factory, store, calls, plan, repairs: () => repairs };
}

test("commit subject describes the verified docs change rather than the request", async (t) => {
  const f = fixture(t);
  f.plan.files = ["guide.md"];
  const run = f.factory.agents.run;
  f.factory.agents.run = async (...args) => {
    if (args[0] === "worker") {
      writeFileSync(join(args[2], "guide.md"), "Usage instructions\n");
      return { summary: "Documented usage", scopeChange: "" };
    }
    const result = await run(...args);
    if (args[0] === "triage") {
      assert.match(args[1], /actual full verified task delta/);
      return { ...(result as object), commitSubject: "docs: document usage" };
    }
    return result;
  };
  await f.factory.request("Build a new dashboard", "local");
  const s = present(f.store.state);
  assert.equal(s.phase, "completed", s.error);
  assert.equal(git(present(s.worktree), "log", "-1", "--format=%s"), "docs: document usage");
});

for (const subject of [
  "factory: update app",
  "fix: update\nbody",
  "fix: a\u0000b",
  "fix: a\u001bb",
  "fix: a\tb",
  "fix: a\u0085b",
  "fix: a\u2028b",
  "fix: a\u2029b",
  `docs: ${"x".repeat(67)}`,
  "fix: ",
]) {
  test(`invalid commit subject is blocked: ${JSON.stringify(subject)}`, async (t) => {
    const f = fixture(t);
    const run = f.factory.agents.run;
    f.factory.agents.run = async (...args) => {
      const result = await run(...args);
      return args[0] === "triage" ? { ...(result as object), commitSubject: subject } : result;
    };
    await f.factory.request("change app", "local");
    const s = present(f.store.state);
    assert.equal(s.phase, "blocked");
    assert.match(s.error ?? "", /Invalid final commit subject/);
    assert.equal(git(present(s.worktree), "rev-parse", "HEAD"), s.baseRevision);
  });
}

test("autonomous request runs all gates and creates one final commit", async (t) => {
  const f = fixture(t);
  await f.factory.request("change app", "local");
  const s = present(f.store.state);
  assert.equal(s.phase, "completed", s.error);
  assert.equal(git(present(s.worktree), "rev-list", "--count", `${s.baseRevision}..HEAD`), "1");
  assert.deepEqual(f.calls, [
    "planner",
    "challenger",
    "worker",
    "tester",
    "quality",
    "security",
    "ponytail",
    "docs",
    "triage",
  ]);
  f.store.close();
  const reopened = new Store(f.store.dir);
  try {
    assert.equal(reopened.state?.phase, "completed");
  } finally {
    reopened.close();
  }
});

test("planning rejection revises and rereviews before worker dispatch", async (t) => {
  const f = fixture(t);
  const run = f.factory.agents.run;
  let reviews = 0;
  f.factory.agents.run = async (...args) => {
    if (args[0] === "challenger" && reviews++ === 0) {
      f.calls.push("challenger");
      return { approved: false, findings: ["Missing verification"] };
    }
    return run(...args);
  };
  await f.factory.request("change app", "local");
  assert.equal(f.store.state?.phase, "completed", f.store.state?.error);
  assert.deepEqual(f.calls.slice(0, 5), [
    "planner",
    "challenger",
    "planner",
    "challenger",
    "worker",
  ]);
  assert.deepEqual(
    f.store.state?.planning?.reviews.map((r) => r.approved),
    [false, true],
  );
});

test("planning third rejection proceeds with unresolved findings", async (t) => {
  const f = fixture(t);
  const run = f.factory.agents.run;
  const prompts: string[] = [];
  f.factory.agents.run = async (...args) => {
    if (["worker", "quality", "security", "ponytail"].includes(args[0])) {
      prompts.push(JSON.stringify(args));
    }
    if (args[0] === "challenger") {
      f.calls.push("challenger");
      return { approved: false, findings: ["Missing verification"] };
    }
    return run(...args);
  };
  await f.factory.request("change app", "local");
  assert.equal(f.store.state?.phase, "completed", f.store.state?.error);
  assert.deepEqual(f.store.state?.planning?.unresolved, ["Missing verification"]);
  assert.ok(prompts.length > 1 && prompts.every((p) => p.includes("Missing verification")));
  assert.deepEqual(f.calls.slice(0, 6), [
    "planner",
    "challenger",
    "planner",
    "challenger",
    "planner",
    "challenger",
  ]);
});

test("autonomous request exhausts the shared five repairs without committing", async (t) => {
  const f = fixture(t, 99);
  await f.factory.request("change app", "local");
  const s = present(f.store.state);
  assert.equal(s.phase, "blocked");
  assert.match(s.error ?? "", /Five repair cycles/);
  assert.equal(f.repairs(), 5);
  assert.equal(f.calls.filter((x) => x === "triage").length, 6);
  assert.equal(git(present(s.worktree), "rev-parse", "HEAD"), s.baseRevision);
});

test("documentation findings consume one repair and rerun every gate", async (t) => {
  const f = fixture(t);
  const run = f.factory.agents.run;
  let audits = 0;
  f.factory.agents.run = async (...args) => {
    if (args[0] === "docs") {
      f.calls.push("docs");
      return { summary: "Update documentation", changes: ++audits === 1 };
    }
    return run(...args);
  };
  await f.factory.request("change app", "local");
  assert.equal(f.factory.state.phase, "completed", f.factory.state.error);
  assert.equal(f.repairs(), 1);
  for (const role of ["tester", "quality", "security", "ponytail", "docs", "triage"]) {
    assert.equal(f.calls.filter((call) => call === role).length, 2, role);
  }
});

test("scope changes are replanned automatically and included in review", async (t) => {
  const f = fixture(t);
  const run = f.factory.agents.run;
  let planners = 0;
  f.factory.agents.run = async (...args) => {
    if (args[0] === "planner" && ++planners === 2) {
      f.calls.push("planner");
      return { ...f.plan, files: ["app.txt", "new.txt"] };
    }
    if (args[0] === "worker") {
      writeFileSync(join(args[2], "new.txt"), "new file");
    }
    return run(...args);
  };
  await f.factory.request("change app", "local");
  assert.equal(f.factory.state.phase, "completed", f.factory.state.error);
  assert.equal(f.factory.state.planRevision, 2);
  assert.ok(f.factory.state.reviewPaths?.includes("new.txt"));
});

for (const scenario of [
  "corrected",
  "reordered",
  "exhausted",
  "invalid",
  "mutated",
  "invalid-mutated",
  "invalid-cancelled",
  "invalid-mutated-cancelled",
  "cancelled",
] as const) {
  test(`scope revision retry: ${scenario}`, async (t) => {
    const f = fixture(t);
    const run = f.factory.agents.run;
    let revisions = 0;
    const prompts: string[] = [];
    f.factory.agents.run = async (...args) => {
      if (args[0] === "worker") {
        writeFileSync(join(args[2], "new.txt"), "new file");
      }
      if (args[0] === "planner" && args[1].startsWith("READ ONLY revise")) {
        revisions++;
        prompts.push(args[1]);
        if (scenario.includes("mutated")) {
          writeFileSync(join(args[2], "app.txt"), "tampered");
        }
        if (scenario.includes("cancelled")) {
          f.factory.cancel();
        }
        if (scenario.startsWith("invalid")) {
          return { ...f.plan, verification: [] };
        }
        if (scenario === "reordered") {
          return {
            ...f.plan,
            files: ["app.txt", "new.txt"],
            verification: f.plan.verification.map((verification) => ({
              purpose: verification.purpose,
              args: verification.args,
              command: verification.command,
            })),
          };
        }
        if (scenario === "corrected" && revisions === 2) {
          return { ...f.plan, files: ["app.txt", "new.txt"] };
        }
        return {
          ...f.plan,
          files: ["app.txt", "new.txt"],
          verification: [{ command: "true", args: [], purpose: "Replacement" }],
        };
      }
      return run(...args);
    };
    await f.factory.request("change app", "local");
    const s = f.factory.state;
    assert.equal(revisions, scenario === "corrected" ? 2 : scenario === "exhausted" ? 3 : 1);
    if (scenario === "corrected" || scenario === "reordered") {
      assert.equal(s.phase, "completed", s.error);
      if (scenario === "corrected") {
        assert.match(present(prompts[1]), /Validation failed/);
        assert.ok(present(prompts[1]).includes(JSON.stringify(f.plan.verification)));
      }
      assert.deepEqual(s.plans[1]?.verification, f.plan.verification);
    } else {
      assert.equal(s.phase, "blocked");
      assert.equal(s.planRevision, 1);
      assert.equal(s.plans.length, 1);
      assert.equal(git(present(s.worktree), "rev-parse", "HEAD"), s.baseRevision);
      assert.match(
        s.error ?? "",
        scenario === "exhausted"
          ? /removed an existing verification/
          : scenario.includes("mutated")
            ? /Planner changed the candidate/
            : scenario.includes("cancelled")
              ? /Stop requested/
              : /Invalid plan/,
      );
    }
  });
}

test("tester mutation invalidates candidate evidence and prevents commit", async (t) => {
  const f = fixture(t);
  const run = f.factory.agents.run;
  f.factory.agents.run = async (...args) => {
    if (args[0] === "tester") {
      writeFileSync(join(args[2], "app.txt"), "unreviewed");
    }
    return run(...args);
  };
  await f.factory.request("change app", "local");
  const s = f.factory.state;
  assert.equal(s.phase, "blocked");
  assert.match(s.error ?? "", /tester changed the candidate/);
  assert.equal(git(present(s.worktree), "rev-parse", "HEAD"), s.baseRevision);
});

test("binary review material blocks final commit", async (t) => {
  const f = fixture(t);
  f.plan.files.push("image.bin");
  const run = f.factory.agents.run;
  f.factory.agents.run = async (...args) => {
    if (args[0] === "worker") {
      writeFileSync(join(args[2], "image.bin"), Buffer.from([0, 1, 2]));
    }
    return run(...args);
  };
  await f.factory.request("change app", "local");
  const s = f.factory.state;
  assert.equal(s.phase, "blocked");
  assert.match(s.error ?? "", /Binary changes/);
  assert.equal(git(present(s.worktree), "rev-parse", "HEAD"), s.baseRevision);
});

test("incomplete reviewer coverage blocks final commit", async (t) => {
  const f = fixture(t);
  const run = f.factory.agents.run;
  f.factory.agents.run = async (...args) =>
    args[0] === "quality" ? { summary: "Unreviewed", findings: [], coverage: [] } : run(...args);
  await f.factory.request("change app", "local");
  const s = f.factory.state;
  assert.equal(s.phase, "blocked");
  assert.match(s.error ?? "", /Incomplete quality review coverage/);
  assert.equal(git(present(s.worktree), "rev-parse", "HEAD"), s.baseRevision);
});

test("malformed descriptive coverage is corrected by a fresh review within the shared budget", async (t) => {
  const f = fixture(t);
  f.plan.files = ["README.md"];
  const run = f.factory.agents.run;
  let reviews = 0;
  f.factory.agents.run = async (...args) => {
    if (args[0] === "worker") {
      writeFileSync(join(args[2], "README.md"), "changed");
      return { summary: "Done", scopeChange: "" };
    }
    if (args[0] === "quality" && ++reviews === 1) {
      return {
        summary: "Reviewed",
        findings: [],
        coverage: [
          "README.md — descriptive text",
          "/tmp/review.md",
          "src/fs_util.rs",
          "src/state.rs",
          "src/reconcile.rs",
        ],
      };
    }
    if (args[0] === "quality") {
      assert.match(args[1], /missing \["README.md"\]/);
      assert.match(args[1], /Reinspect/);
    }
    return run(...args);
  };
  await f.factory.request("change README", "local");
  const s = f.factory.state;
  assert.equal(s.phase, "completed", s.error);
  assert.equal(s.repairs, 1);
  assert.equal(f.repairs(), 0);
  assert.equal(git(present(s.worktree), "rev-list", "--count", `${s.baseRevision}..HEAD`), "1");
});

test("repeated malformed coverage exhausts the shared budget and reports the failed stage", async (t) => {
  const f = fixture(t);
  const run = f.factory.agents.run;
  let attempts = 0;
  f.factory.agents.run = async (...args) => {
    if (args[0] === "quality") {
      attempts++;
      return {
        summary: "Cannot inspect",
        findings: [],
        coverage: ["app.txt — described", "/tmp/review.md"],
      };
    }
    return run(...args);
  };
  await f.factory.request("change app", "local");
  const s = f.factory.state;
  assert.equal(s.phase, "blocked");
  assert.equal(s.repairs, 5);
  assert.equal(attempts, 6);
  assert.equal(f.repairs(), 0);
  assert.match(s.error ?? "", /expected \["app.txt"\]; missing \["app.txt"\]; invalid/);
  assert.equal(
    s.evidence.some((e) => e.role === "quality"),
    false,
  );
  assert.equal(f.calls.includes("triage"), false);
  assert.equal(git(present(s.worktree), "rev-parse", "HEAD"), s.baseRevision);
  const report = f.factory.report();
  assert.match(report, /## Plan\/task summary/);
  assert.match(report, /Stage reviewing/);
  assert.match(report, /No accepted findings recorded/);
  assert.doesNotMatch(report, /## Issues\n[^]*?\n- None\n/);
  assert.match(report, /current\/base; not necessarily a final commit/);
});

test("already satisfied request completes without commit", async (t) => {
  const f = fixture(t);
  const run = f.factory.agents.run;
  f.factory.agents.run = async (...args) =>
    args[0] === "worker" ? { summary: "Already satisfied", scopeChange: "" } : run(...args);
  await f.factory.request("already satisfied", "local");
  const s = present(f.store.state);
  assert.equal(s.phase, "completed", s.error);
  assert.equal(s.noChanges, true);
  assert.equal(git(present(s.worktree), "rev-parse", "HEAD"), s.baseRevision);
});

test("legacy active state is preserved and uncertain children prevent a new run", async (t) => {
  const f = fixture(t);
  f.store.close();
  const path = join(f.store.dir, "state.json");
  const historical = JSON.stringify(
    {
      version: 1,
      id: "00000000-0000-4000-8000-000000000000",
      phase: "implementing",
      active: { role: "worker" },
    },
    null,
    2,
  );
  writeFileSync(path, historical);
  const reopened = new Store(f.store.dir);
  try {
    const factory = new Factory(reopened, new Git(f.repo), f.factory.agents, f.factory.delivery);
    await assert.rejects(
      factory.request("new work", "local"),
      /Legacy run has an uncertain operation/,
    );
    assert.equal(readFileSync(path, "utf8"), historical);
    assert.equal(reopened.legacy?.phase, "implementing");
  } finally {
    reopened.close();
  }
});

test("legacy terminal state is archived before a fresh autonomous run", async (t) => {
  const f = fixture(t);
  f.store.close();
  const id = "00000000-0000-4000-8000-000000000001";
  const legacy = { version: 1, id, phase: "completed", request: "historical" };
  writeFileSync(join(f.store.dir, "state.json"), JSON.stringify(legacy));
  const reopened = new Store(f.store.dir);
  try {
    const factory = new Factory(reopened, new Git(f.repo), f.factory.agents, f.factory.delivery);
    await factory.request("new work", "local");
    assert.equal(factory.state.phase, "completed", factory.state.error);
    assert.equal(factory.state.version, 2);
    assert.deepEqual(JSON.parse(readFileSync(join(f.store.dir, `${id}.json`), "utf8")), legacy);
  } finally {
    reopened.close();
  }
});

test("matching legacy archive permits retry without changing archive bytes", async (t) => {
  const f = fixture(t);
  f.store.close();
  const id = "00000000-0000-4000-8000-000000000002";
  const state = JSON.stringify({ version: 1, id, phase: "blocked", extra: { a: 1, b: 2 } });
  const archive = JSON.stringify(
    { extra: { b: 2, a: 1 }, phase: "blocked", id, version: 1 },
    null,
    2,
  );
  const path = join(f.store.dir, `${id}.json`);
  writeFileSync(join(f.store.dir, "state.json"), state);
  writeFileSync(path, archive);
  const reopened = new Store(f.store.dir);
  try {
    const factory = new Factory(reopened, new Git(f.repo), f.factory.agents, f.factory.delivery);
    await factory.request("new work", "local");
    assert.equal(factory.state.phase, "completed", factory.state.error);
    assert.equal(reopened.legacy, undefined);
    assert.equal(readFileSync(path, "utf8"), archive);
  } finally {
    reopened.close();
  }
});

test("different or malformed legacy archives are preserved and collisions are idempotent", async (t) => {
  for (const archive of [
    JSON.stringify({ version: 1, id: "00000000-0000-4000-8000-000000000003", phase: "completed" }),
    "not json",
  ]) {
    const f = fixture(t);
    f.store.close();
    const id = "00000000-0000-4000-8000-000000000003";
    const statePath = join(f.store.dir, "state.json");
    const archivePath = join(f.store.dir, `${id}.json`);
    const legacy = { version: 1, id, phase: "blocked" };
    writeFileSync(statePath, JSON.stringify(legacy));
    writeFileSync(archivePath, archive);
    const reopened = new Store(f.store.dir);
    try {
      reopened.archive();
      reopened.legacy = legacy;
      reopened.archive();
      const second = { ...legacy, request: "another historical state" };
      reopened.legacy = second;
      reopened.archive();
      const paths = readdirSync(f.store.dir).filter((name) => name.startsWith(`${id}-legacy-`));
      assert.equal(paths.length, 2);
      const archived = paths.map((name) =>
        JSON.parse(readFileSync(join(f.store.dir, name), "utf8")),
      );
      assert.ok(archived.some((value) => value.request === undefined));
      assert.ok(archived.some((value) => value.request === second.request));
      assert.equal(readFileSync(archivePath, "utf8"), archive);
      reopened.legacy = legacy;
      const factory = new Factory(reopened, new Git(f.repo), f.factory.agents, f.factory.delivery);
      // oxlint-disable-next-line no-await-in-loop -- Each fixture has its own locked store.
      await factory.request("new work", "local");
      assert.equal(factory.state.phase, "completed", factory.state.error);
      assert.equal(
        readdirSync(f.store.dir).filter((name) => name.startsWith(`${id}-legacy-`)).length,
        2,
      );
    } finally {
      reopened.close();
    }
  }
});

test("later setup failure preserves collision archive", async (t) => {
  const f = fixture(t);
  f.store.close();
  const id = "00000000-0000-4000-8000-000000000004";
  const state = JSON.stringify({ version: 1, id, phase: "blocked", request: "historical" });
  const path = join(f.store.dir, `${id}.json`);
  writeFileSync(join(f.store.dir, "state.json"), state);
  writeFileSync(path, "malformed archive");
  const reopened = new Store(f.store.dir);
  try {
    const factory = new Factory(reopened, new Git(f.repo), f.factory.agents, f.factory.delivery);
    factory.git.create = () => {
      throw new Error("injected setup failure");
    };
    await assert.rejects(factory.plan("new work", "local"), /injected setup failure/);
    assert.equal(readFileSync(path, "utf8"), "malformed archive");
    const alternate = present(
      readdirSync(f.store.dir).find((name) => name.startsWith(`${id}-legacy-`)),
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(f.store.dir, alternate), "utf8")),
      JSON.parse(state),
    );
  } finally {
    reopened.close();
  }
});

test("failed worktree setup preserves registered worktree, branch and durable intent", async (t) => {
  const f = fixture(t);
  git(f.repo, "branch", "keep-me");
  const original = f.factory.git.git.bind(f.factory.git);
  f.factory.git.git = (args, cwd) => {
    const result = original(args, cwd);
    if (args[0] === "worktree" && args[1] === "add") {
      throw new Error("injected setup failure");
    }
    return result;
  };
  await assert.rejects(f.factory.plan("change app", "local"), /injected setup failure/);
  const s = present(f.store.state);
  assert.ok(git(f.repo, "branch", "--list", s.branch).includes(s.branch));
  assert.equal(git(f.repo, "branch", "--list", "keep-me"), "keep-me");
  assert.ok(git(f.repo, "worktree", "list", "--porcelain").includes(s.branch));
  assert.equal(s.active?.role, "worktree-create");
  await assert.rejects(f.factory.resume(), /uncertain/i);
  assert.equal(git(f.repo, "branch", "--show-current"), "main");
});

test("planning uses an isolated worktree and leaves a dirty original checkout untouched", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repo, "app.txt"), "staged");
  git(f.repo, "add", "app.txt");
  writeFileSync(join(f.repo, "app.txt"), "unstaged");
  writeFileSync(join(f.repo, "untracked.txt"), "untracked");
  const originalStatus = git(f.repo, "status", "--porcelain");
  let plannerCwd = "";
  const run = f.factory.agents.run;
  f.factory.agents.run = async (...args) => {
    if (args[0] === "planner") {
      plannerCwd = args[2];
    }
    return run(...args);
  };
  await f.factory.plan("change app", "local");
  const s = present(f.store.state);
  assert.notEqual(s.worktree, f.repo);
  assert.equal(plannerCwd, s.worktree);
  assert.equal(readFileSync(join(present(s.worktree), "app.txt"), "utf8"), "old");
  assert.equal(git(f.repo, "status", "--porcelain"), originalStatus);
  assert.equal(git(f.repo, "branch", "--show-current"), "main");
});

test("worktree snapshot excludes ignored files and does not follow untracked symlinks", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change app", "local");
  const s = present(f.store.state);
  const worktree = present(s.worktree);
  writeFileSync(join(worktree, ".gitignore"), "node_modules/\n");
  makeDirectory(join(worktree, "node_modules"));
  writeFileSync(join(worktree, "node_modules", "dep"), "one");
  const target = join(f.root, "external");
  writeFileSync(target, "one");
  symlinkSync(target, join(worktree, "link"));
  const snapshot = f.factory.git.snapshot(s);
  writeFileSync(target, "two");
  writeFileSync(join(worktree, "node_modules", "dep"), "two");
  assert.equal(f.factory.git.snapshot(s), snapshot);
  writeFileSync(join(worktree, "new.txt"), "new");
  assert.notEqual(f.factory.git.snapshot(s), snapshot);
});

test("worktree snapshot rejects changed submodules", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change app", "local");
  const s = present(f.store.state);
  const worktree = present(s.worktree);
  git(worktree, "update-index", "--add", "--cacheinfo", `160000,${s.baseRevision},submodule`);
  assert.throws(() => f.factory.git.snapshot(s), /Changed submodules/);
});

test("GitHub delivery rejects a target that does not match origin before network access", async (t) => {
  const f = fixture(t);
  git(f.repo, "remote", "add", "origin", "https://github.com/example/repo.git");
  await f.factory.request("change app", "local");
  const s = f.factory.state;
  assert.equal(s.phase, "completed", s.error);
  s.target = { repo: "example/repo", base: "main", remote: "https://github.com/attacker/repo.git" };
  const delivery = new PreflightDelivery(new Git(f.repo), f.store.dir);
  await assert.rejects(
    delivery.deliver(s, "", () => {}),
    /does not match origin/,
  );
});

test("GitHub preflight records the default base independently of the local starting branch", async (t) => {
  const f = fixture(t);
  git(f.repo, "switch", "-c", "feature/base");
  git(f.repo, "remote", "add", "origin", "https://github.com/example/repo.git");
  const delivery = new PreflightDelivery(new Git(f.repo), f.store.dir);
  const remoteHead = "0".repeat(40);
  const calls: string[][] = [];
  Object.defineProperty(delivery, "gh", {
    value: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "repo") {
        return JSON.stringify({
          nameWithOwner: "example/repo",
          defaultBranchRef: { name: "main" },
          isArchived: false,
          viewerPermission: "WRITE",
        });
      }
      if (args[1] === "repos/example/repo/branches/main") {
        return JSON.stringify({ commit: { sha: remoteHead } });
      }
      return args[0] === "api" ? "[]" : "";
    },
  });
  const target = await delivery.preflight();
  assert.equal(target.base, "main");
  assert.equal(target.baseRevision, remoteHead);
  assert.ok(calls.some((args) => args[1]?.endsWith("/branches/main")));
  assert.ok(!calls.some((args) => args[1]?.includes("feature%2Fbase")));
});

test("GitHub reconciliation checks the recorded remote base, including legacy state", async (t) => {
  const f = fixture(t);
  git(f.repo, "remote", "add", "origin", "https://github.com/example/repo.git");
  await f.factory.request("change app", "local");
  const s = f.factory.state;
  const delivery = new PreflightDelivery(new Git(f.repo), f.store.dir);
  const remoteBase = "1".repeat(40);
  s.target = {
    repo: "example/repo",
    base: "main",
    remote: "https://github.com/example/repo.git",
    baseRevision: remoteBase,
  };
  let actual = "2".repeat(40);
  Object.defineProperty(delivery, "gh", {
    value: async (args: string[]) => {
      if (args[0] === "repo") {
        return JSON.stringify({
          nameWithOwner: "example/repo",
          defaultBranchRef: { name: "main" },
          isArchived: false,
          viewerPermission: "WRITE",
        });
      }
      if (args[1]?.includes("/branches/main")) {
        return JSON.stringify({ commit: { sha: actual } });
      }
      if (args[1]?.includes("/rules/")) {
        throw new Error("base accepted");
      }
      return "";
    },
  });
  await assert.rejects(
    delivery.reconcile(s, () => {}, false),
    /Remote base moved/,
  );
  actual = remoteBase;
  await assert.rejects(
    delivery.reconcile(s, () => {}, false),
    /base accepted/,
  );
  delete s.target.baseRevision;
  await assert.rejects(
    delivery.reconcile(s, () => {}, false),
    /Remote base moved/,
  );
  actual = s.baseRevision;
  await assert.rejects(
    delivery.reconcile(s, () => {}, false),
    /base accepted/,
  );
});

test("autonomous GitHub lifecycle binds final evidence to the final revision", async (t) => {
  const f = fixture(t);
  await f.factory.request("change app", "github");
  const s = f.factory.state;
  assert.equal(s.phase, "completed", s.error);
  assert.equal(s.pr?.draft, true);
  assert.ok(s.evidence.length > 0);
  assert.ok(s.evidence.filter((e) => e.round === s.round).every((e) => e.revision === s.revision));
  assert.equal(readFileSync(join(f.repo, "app.txt"), "utf8"), "old");
  assert.notEqual(s.worktree, f.repo);
  assert.equal(git(present(s.worktree), "status", "--porcelain"), "");
  assert.deepEqual(f.calls, [
    "planner",
    "challenger",
    "worker",
    "tester",
    "quality",
    "security",
    "ponytail",
    "docs",
    "triage",
  ]);
});

test("failures trigger two repairs, then block", async (t) => {
  const f = fixture(t, 99);
  await f.factory.plan("change", "github");
  await f.factory.drive();
  assert.equal(f.repairs(), 5);
  assert.equal(f.store.state?.phase, "blocked");
  assert.match(present(present(f.store.state).error), /repair/i);
});

test("one failed test repairs and revalidates", async (t) => {
  const f = fixture(t, 1);
  await f.factory.plan("change", "github");
  await f.factory.drive();
  assert.equal(f.repairs(), 1);
  assert.equal(f.store.state?.phase, "completed");
});

test("writer lock and interrupted worker preserve artifacts", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "github");
  assert.throws(() => new Store(f.store.dir), /writer/i);
  present(f.store.state).active = { role: "worker", requestId: "uncertain", started: Date.now() };
  f.store.save();
  f.store.close();
  const reopened = new Store(f.store.dir);
  try {
    assert.equal(reopened.state?.phase, "blocked");
    assert.ok(reopened.state?.active);
    await assert.rejects(
      new Factory(reopened, new Git(f.repo), f.factory.agents, f.factory.delivery).resume(),
      /uncertain/i,
    );
    assert.ok(existsSync(present(reopened.state?.worktree)));
  } finally {
    reopened.close();
  }
});

test("scope escape blocks delivery and revokes approval", async (t) => {
  const f = fixture(t);
  f.factory.agents.run = async (role: string, task: string, cwd: string) => {
    if (role === "planner") {
      return f.plan;
    }
    if (role === "challenger") {
      return { approved: true, findings: [] };
    }
    writeFileSync(join(cwd, "unapproved.txt"), "escape");
    return { summary: "done", scopeChange: "" };
  };
  await f.factory.plan("change", "github");
  await f.factory.drive();
  assert.equal(f.store.state?.phase, "blocked");
  assert.ok(existsSync(join(present(present(f.store.state).worktree), "unapproved.txt")));
});

test("pause and resume preserve a runnable autonomous plan", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "github");
  f.factory.pause();
  assert.match(f.factory.report(), /planning.*paused/);
  assert.match(status(f.factory.state), /planning.*paused/);
  await assert.rejects(f.factory.drive(), /runnable/);
  await f.factory.resume();
  await f.factory.drive();
  assert.equal(f.factory.state.phase, "completed", f.factory.state.error);
});

test("approved command failure blocks delivery even if tester claims success", async (t) => {
  const f = fixture(t);
  present(f.plan.verification[0]).args = ["-e", "process.exit(1)"];
  await f.factory.plan("change", "github");
  await f.factory.drive();
  assert.equal(present(f.store.state).phase, "blocked");
  assert.equal(present(f.store.state).pr, undefined);
  assert.equal(f.repairs(), 5);
});

test("documentation findings are repaired and all gates rerun", async (t) => {
  const f = fixture(t);
  f.plan.files.push("docs.txt");
  const run = f.factory.agents.run.bind(f.factory.agents);
  let audits = 0;
  f.factory.agents.run = async (...args) => {
    if (args[0] === "docs" && ++audits === 1) {
      return { summary: "Update docs", changes: true };
    }
    if (args[0] === "repair") {
      writeFileSync(join(args[2], "docs.txt"), "new docs");
      return { summary: "docs", scopeChange: "" };
    }
    return run(...args);
  };
  await f.factory.request("change", "github");
  const s = f.factory.state;
  assert.equal(s.phase, "completed", s.error);
  assert.equal(audits, 2);
  assert.ok(
    s.evidence.some((e) => e.role === "tester" && e.round === s.round && e.revision === s.revision),
  );
});

test("worker commit and staged unapproved changes block and preserve artifacts", async (t) => {
  const f = fixture(t);
  const run = f.factory.agents.run.bind(f.factory.agents);
  f.factory.agents.run = async (role, task, cwd, identity, signal) => {
    if (role !== "worker") {
      return run(role, task, cwd, identity, signal);
    }
    writeFileSync(join(cwd, "app.txt"), "committed");
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "unauthorized");
    return { summary: "committed", scopeChange: "" };
  };
  await f.factory.plan("change", "github");
  await f.factory.drive();
  assert.equal(present(f.store.state).phase, "blocked");
  assert.match(present(present(f.store.state).error), /HEAD|revision|changed/i);
  assert.equal(present(f.store.state).pr, undefined);
});

test("delivery uncertainty is preserved and cannot be resumed", async (t) => {
  const f = fixture(t);
  f.factory.delivery.deliver = async () => {
    throw new Error("uncertain push");
  };
  await f.factory.plan("change", "github");
  await f.factory.drive();
  assert.equal(present(f.store.state).phase, "blocked");
  assert.ok(present(f.store.state).deliveryIntent);
  await assert.rejects(f.factory.resume(), /uncertain/i);
});

test("GitHub remote inspection failures and existing refs preserve final intent", async (t) => {
  const { chmodSync } = await import("node:fs");
  const f = fixture(t);
  git(f.repo, "remote", "add", "origin", "https://github.com/example/repo.git");
  const bin = join(f.root, "bin");
  makeDirectory(bin);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const log = join(f.root, "calls");
  writeFileSync(
    join(bin, "git"),
    `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process'),a=process.argv.slice(2); if(a[0]==='ls-remote'){if(process.env.TEST_EXISTING){console.log('abc\\trefs/heads/factory/existing');process.exit(0)} console.error('fatal: Authentication failed for https://user:secret@example.com/token SECRET_TOKEN');process.exit(2)} if(a.includes('push')) fs.appendFileSync(${JSON.stringify(log)},'push\\n'); const r=cp.spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});process.exit(r.status ?? 1);
`,
  );
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2); if(a[0]==='pr'&&a[1]==='create') fs.appendFileSync(${JSON.stringify(log)},'create\\n'); if(a[0]==='api'&&a[1].includes('/rules/')) console.log('[]'); else if(a[0]==='pr'&&a[1]==='list') console.log('[]'); else process.exit(1);
`,
  );
  chmodSync(join(bin, "git"), 0o755);
  chmodSync(join(bin, "gh"), 0o755);
  const oldPath = process.env.PATH;
  const oldExisting = process.env.TEST_EXISTING;
  t.after(() => {
    if (oldPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = oldPath;
    }
    if (oldExisting === undefined) {
      delete process.env.TEST_EXISTING;
    } else {
      process.env.TEST_EXISTING = oldExisting;
    }
  });
  process.env.PATH = bin + ":" + oldPath;
  delete process.env.TEST_EXISTING;
  await f.factory.plan("change", "github");
  f.factory.delivery = new PreflightDelivery(f.factory.git, f.store.dir);
  await f.factory.drive();
  const s = f.factory.state;
  assert.equal(s.phase, "blocked");
  assert.match(
    present(s.error),
    /git ls-remote exit 2; stderr: authentication or permission failure/,
  );
  assert.doesNotMatch(present(s.error), /secret|SECRET_TOKEN|example\.com/);
  assert.match(f.factory.report(), /outcome: delivery failed/);
  assert.match(f.factory.report(), new RegExp(`Revision \\(final\\): ${s.revision}`));
  const head = git(present(s.worktree), "rev-parse", "HEAD");
  assert.equal(head, s.deliveryIntent);
  await assert.rejects(f.factory.resume(), /uncertain/i);
  assert.equal(git(present(s.worktree), "rev-parse", "HEAD"), head);
  assert.equal(existsSync(log), false);
  process.env.TEST_EXISTING = "1";
  await assert.rejects(
    f.factory.delivery.deliver(s, "", () => {}),
    /already exists; reconcile/,
  );
  assert.equal(existsSync(log), false);
});

test("uncertain worker cannot be replayed automatically", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "github");
  const s = f.factory.state;
  s.active = { role: "worker", requestId: "stopped", started: Date.now() };
  f.store.save();
  await assert.rejects(f.factory.resume(), /uncertain/i);
  await assert.rejects(f.factory.drive(), /runnable/i);
  assert.equal(s.active.role, "worker");
  assert.deepEqual(f.calls, ["planner"]);
});

test("GitHub delivery uses fake gh and a disposable local remote", async (t) => {
  const { mkdirSync, chmodSync } = await import("node:fs");
  const { GitHubDelivery } = await import("../src/delivery.ts");
  const f = fixture(t);
  const bare = join(f.root, "remote.git");
  git(f.root, "init", "--bare", bare);
  git(f.repo, "remote", "add", "origin", "https://github.com/example/repo.git");
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  const gh = join(bin, "gh");
  const gitWrapper = join(bin, "git");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(
    gitWrapper,
    `#!${process.execPath}
const cp=require('node:child_process'); const args=process.argv.slice(2); if(args[0]==='ls-remote') args[2]=process.env.TEST_BARE; const result=cp.spawnSync(${JSON.stringify(realGit)}, args, {stdio:'inherit'}); process.exit(result.status ?? 1);
`,
  );
  chmodSync(gitWrapper, 0o755);
  writeFileSync(
    gh,
    `#!${process.execPath}\nconst a=process.argv.slice(2);\nif(a[0]==='auth') console.log('ok');\nelse if(a[0]==='repo') console.log(JSON.stringify({nameWithOwner:'example/repo',defaultBranchRef:{name:'main'},isArchived:false,viewerPermission:'WRITE'}));\nelse if(a[0]==='api' && a[1].includes('/rules/')) console.log('[]');\nelse if(a[0]==='api') console.log(JSON.stringify({commit:{sha:process.env.TEST_BASE}}));\nelse if(a[0]==='pr' && a[1]==='list') console.log('[]');\nelse if(a[0]==='pr' && a[1]==='create') console.log('https://github.com/example/repo/pull/1');\nelse if(a[0]==='pr' && a[1]==='view') {const cp=require('node:child_process'); const refs=cp.execFileSync('git',['--git-dir',process.env.TEST_BARE,'for-each-ref','--format=%(refname:short) %(objectname)','refs/heads/factory/'],{encoding:'utf8'}).trim().split(' '); console.log(JSON.stringify({url:'https://github.com/example/repo/pull/1',isDraft:true,headRefName:refs[0],headRefOid:refs[1],baseRefName:'main'}));} else process.exit(1);\n`,
  );
  chmodSync(gh, 0o755);
  const old = {
    PATH: process.env.PATH,
    TEST_BASE: process.env.TEST_BASE,
    TEST_BARE: process.env.TEST_BARE,
  };
  t.after(() => {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });
  process.env.PATH = bin + ":" + old.PATH;
  process.env.TEST_BASE = git(f.repo, "rev-parse", "HEAD");
  process.env.TEST_BARE = bare;
  f.factory.delivery = new GitHubDelivery(f.factory.git, f.store.dir);
  await f.factory.plan("change", "github");
  git(f.repo, "config", `url.${bare}.pushInsteadOf`, "https://github.com/example/repo.git");
  await f.factory.drive();
  assert.equal(present(f.store.state).phase, "completed", present(f.store.state).error);
  assert.equal(
    git(f.root, "--git-dir", bare, "rev-parse", `refs/heads/${present(f.store.state).branch}`),
    present(f.store.state).revision,
  );
});

test("uncertain and cancelled runs cannot be replaced or recovered", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "github");
  const s = present(f.store.state);
  s.active = { role: "worker", requestId: "uncertain", started: Date.now() };
  s.cancelled = true;
  s.phase = "blocked";
  f.store.save();
  await assert.rejects(f.factory.plan("another", "github"), /uncertain/);
  await assert.rejects(f.factory.resume(), /uncertain/i);
  assert.equal(s.active.requestId, "uncertain");
});

test("blocked quality gate preserves repair count and cannot resume", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "github");
  const s = f.factory.state;
  s.phase = "blocked";
  s.repairs = 2;
  f.store.save();
  await assert.rejects(f.factory.resume(), /quality gate/i);
  assert.equal(s.repairs, 2);
});

test("exhausted quality gate cannot resume or bypass verification", async (t) => {
  const f = fixture(t, 99);
  await f.factory.request("change", "github");
  const s = f.factory.state;
  assert.equal(s.phase, "blocked");
  assert.equal(s.repairs, 5);
  const evidence = structuredClone(s.evidence);
  const worktree = present(s.worktree);
  await assert.rejects(f.factory.resume(), /quality gate/i);
  await assert.rejects(f.factory.drive(), /runnable/i);
  assert.deepEqual(s.evidence, evidence);
  assert.equal(git(worktree, "rev-parse", "HEAD"), s.baseRevision);
  assert.equal(s.pr, undefined);
});

test("invalid persisted gate fields fail closed without modifying the file", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "github");
  f.store.close();
  const path = join(f.store.dir, "state.json");
  const s = JSON.parse(readFileSync(path, "utf8"));
  s.repairs = -1;
  const invalid = JSON.stringify(s);
  writeFileSync(path, invalid);
  assert.throws(() => new Store(f.store.dir), /invalid/i);
  assert.equal(readFileSync(path, "utf8"), invalid);
});

test("pause after tester prevents approved commands and reviewers", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "github");
  const run = f.factory.agents.run.bind(f.factory.agents);
  f.factory.agents.run = async (...args) => {
    const result = await run(...args);
    if (args[0] === "tester") {
      f.factory.pause();
    }
    return result;
  };
  await f.factory.drive();
  assert.equal(present(f.store.state).paused, true);
  assert.equal(f.calls.includes("quality"), false);
  assert.equal(
    present(f.store.state).evidence.some((e) => e.role === "command"),
    false,
  );
});

test("cancellation during preflight prevents planner and worker execution", async (t) => {
  const f = fixture(t);
  f.factory.agents.preflight = async () => {
    f.factory.cancel();
  };
  await assert.rejects(f.factory.request("change", "github"), /stop/i);
  assert.equal(f.factory.state.cancelled, true);
  assert.ok(f.factory.state.worktree);
  assert.deepEqual(f.calls, []);
  assert.equal(git(f.repo, "branch", "--show-current"), "main");
});

test("invalid persisted evidence is rejected without rewriting the state", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "github");
  await f.factory.drive();
  f.store.close();
  const path = join(f.store.dir, "state.json");
  const s = JSON.parse(readFileSync(path, "utf8"));
  s.evidence.find((e: Evidence) => e.role === "tester").result = { passed: true };
  const invalid = JSON.stringify(s);
  writeFileSync(path, invalid);
  assert.throws(() => new Store(f.store.dir), /invalid/i);
  assert.equal(readFileSync(path, "utf8"), invalid);
});

test("restart blocks a nonterminal boundary even without an active child", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "github");
  f.factory.state.phase = "implementing";
  f.store.save();
  f.store.close();
  const reopened = new Store(f.store.dir);
  try {
    assert.equal(present(reopened.state).phase, "blocked");
    assert.match(present(present(reopened.state).error), /Interrupted/);
  } finally {
    reopened.close();
  }
});

test("persisted delivery evidence must match approved commands", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "github");
  await f.factory.drive();
  const state = present(f.store.state);
  assert.equal(state.phase, "completed");
  const command = present(
    state.evidence.find((e) => e.role === "command" && e.round === state.round),
  );
  assert.ok(command.result && typeof command.result === "object" && "command" in command.result);
  assert.ok(command.result.command && typeof command.result.command === "object");
  command.result.command = {
    ...command.result.command,
    args: ["-e", "process.exit(1)"],
  };
  f.store.save();
  f.store.close();
  assert.throws(() => new Store(f.store.dir), /Invalid factory state/);
});

test("command dispatch prevents concurrent runs and waits for shutdown", async (t) => {
  const { registerFactoryCommands } = await import("../src/commands.ts");
  const f = fixture(t);
  let handler!: CommandHandler,
    shutdown!: () => Promise<void>,
    started!: () => void,
    release!: () => void;
  const waiting = new Promise<void>((r) => {
    started = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const run = f.factory.agents.run;
  f.factory.agents.run = async (...args) => {
    if (args[0] === "planner") {
      started();
      await gate;
    }
    return run(...args);
  };
  const notices: string[] = [];
  registerFactoryCommands(
    {
      registerCommand(_name: string, command: Command) {
        handler = command.handler;
      },
      on(_event: string, cb: () => Promise<void>) {
        shutdown = cb;
      },
    },
    async () => f.factory,
    () => f.store.close(),
  );
  const ctx = {
    ui: {
      notify(message: string) {
        notices.push(message);
      },
    },
  };
  await handler("request change app", ctx);
  await waiting;
  await handler("request another", ctx);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(notices.some((n) => /busy|progress/i.test(n)));
  const stopping = shutdown();
  assert.throws(() => new Store(f.store.dir), /writer/);
  release();
  await stopping;
  const reopened = new Store(f.store.dir);
  try {
    assert.equal(reopened.state?.cancelled, true);
  } finally {
    reopened.close();
  }
});

test("command pause and cancel interrupt planning without approval", async (t) => {
  const { registerFactoryCommands } = await import("../src/commands.ts");
  // oxlint-disable no-await-in-loop -- Pause and cancel each exercise a complete command lifecycle; serialize fixture cleanup.
  for (const action of ["pause", "cancel"]) {
    const f = fixture(t);
    let handler!: CommandHandler;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      f.factory.agents.run = async () => {
        resolve();
        await new Promise<void>((r) => {
          release = r;
        });
        return f.plan;
      };
    });
    const pi = {
      registerCommand(_name: string, command: Command) {
        handler = command.handler;
      },

      on() {},
    };
    const ctx = { ui: { notify() {} } };
    registerFactoryCommands(
      pi,
      async () => f.factory,
      () => f.store.close(),
    );
    const request = handler("request change", ctx);
    await started;
    await handler(action, ctx);
    release();
    await request;
    await waitFor(() => present(f.store.state).phase === "failed");
    assert.equal(present(f.store.state).phase, "failed");
    assert.equal(present(f.store.state).paused, true);
    assert.equal(present(f.store.state).cancelled, action === "cancel");
  }
  // oxlint-enable no-await-in-loop
});

test("concurrent commands share initialization and deny a duplicate request", async (t) => {
  const { registerFactoryCommands } = await import("../src/commands.ts");
  const f = fixture(t);
  let handler!: CommandHandler,
    release!: () => void,
    calls = 0;
  const notices: string[] = [];
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const pi = {
    registerCommand(_name: string, command: Command) {
      handler = command.handler;
    },

    on() {},
  };
  const ctx = {
    ui: {
      notify(message: string) {
        notices.push(message);
      },
    },
  };
  registerFactoryCommands(
    pi,
    async () => {
      calls++;
      await gate;
      return f.factory;
    },
    () => f.store.close(),
  );
  const first = handler("first", ctx);
  await handler("second", ctx);
  const statusRequest = handler("status", ctx);
  release();
  await Promise.all([first, statusRequest]);
  assert.equal(calls, 1);
  assert.ok(notices.some((n) => /already in progress/.test(n)));
  assert.equal(present(f.store.state).request, "first");
});

test("persisted delivery state rejects inconsistent task or documentation", async (t) => {
  // oxlint-disable no-await-in-loop -- Complete each plan, execution, and reload before corrupting the next isolated store.
  for (const corrupt of [
    (s: Run) => {
      s.task = 0;
    },
    (s: Run) => {
      s.documented = false;
    },
    (s: Run) => {
      s.plans = [];
    },
  ]) {
    const f = fixture(t);
    await f.factory.plan("change", "github");
    await f.factory.drive();
    assert.ok(f.store.state);
    corrupt(f.store.state);
    f.store.save();
    f.store.close();
    assert.throws(() => new Store(f.store.dir), /Invalid factory state/);
  }
  // oxlint-enable no-await-in-loop
});

test("pause or cancellation during planning preflight prevents execution", async (t) => {
  // oxlint-disable no-await-in-loop -- Serialize independent paused and cancelled fixtures.
  for (const action of ["pause", "cancel"] as const) {
    const f = fixture(t);
    let started!: () => void, release!: () => void;
    const waiting = new Promise<void>((r) => {
      started = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    f.factory.agents.preflight = async () => {
      started();
      await gate;
    };
    const request = f.factory.request("change", "local");
    await waiting;
    f.factory[action]();
    release();
    await assert.rejects(request, /stop/i);
    assert.deepEqual(f.calls, []);
    assert.equal(f.factory.state.paused, true);
    assert.equal(f.factory.state.cancelled, action === "cancel");
  }
  // oxlint-enable no-await-in-loop
});

test("cancellation during planning persists uncertain child across restart", async (t) => {
  const f = fixture(t);
  let started!: () => void, release!: () => void;
  const waiting = new Promise<void>((r) => {
    started = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  f.factory.agents.run = async () => {
    started();
    await gate;
    return f.plan;
  };
  const request = f.factory.request("change", "github");
  await waiting;
  f.factory.cancel();
  release();
  await assert.rejects(request, /stop/i);
  f.store.close();
  const reopened = new Store(f.store.dir);
  try {
    assert.equal(reopened.state?.cancelled, true);
    assert.equal(reopened.state?.phase, "failed");
    await assert.rejects(
      new Factory(reopened, new Git(f.repo), f.factory.agents, f.factory.delivery).resume(),
      /cancelled|uncertain/i,
    );
  } finally {
    reopened.close();
  }
});

test("final review findings require exact triage and persisted findings", async (t) => {
  const f = fixture(t);
  const run = f.factory.agents.run.bind(f.factory.agents);
  f.factory.agents.run = async (...args) => {
    if (args[0] === "quality") {
      return {
        summary: "Review",
        coverage: ["app.txt"],
        findings: [{ id: "suspect", blocking: true, evidence: "Suspected defect" }],
      };
    }
    if (args[0] === "triage") {
      return {
        findings: [
          {
            id: "quality:suspect",
            blocking: true,
            confirmed: false,
            evidence: "Contradicted by source",
          },
        ],
        complete: true,
        completionEvidence: "Request complete",
        commitSubject: "fix: update app",
      };
    }
    return run(...args);
  };
  await f.factory.plan("change", "github");
  await f.factory.drive();
  assert.equal(present(f.store.state).phase, "completed", present(f.store.state).error);
  assert.match(f.factory.report(), /Rejected: Contradicted by source/);
  assert.doesNotMatch(f.factory.report(), /Blocking: Contradicted by source/);
  f.store.close();
  const path = join(f.store.dir, "state.json");
  const valid = JSON.parse(readFileSync(path, "utf8"));
  const reopened = new Store(f.store.dir);
  reopened.close();
  for (const corrupt of [
    (s: Run) => {
      s.findings = [];
    },
    (s: Run) => {
      const triage = s.evidence.find((e) => e.round === s.round && e.role === "triage");
      assert.ok(triage?.result && typeof triage.result === "object" && "findings" in triage.result);
      assert.ok(Array.isArray(triage.result.findings));
      const finding: unknown = triage.result.findings[0];
      assert.ok(finding && typeof finding === "object" && "confirmed" in finding);
      finding.confirmed = true;
    },
    (s: Run) => {
      const triage = s.evidence.find((e) => e.round === s.round && e.role === "triage");
      assert.ok(triage?.result && typeof triage.result === "object" && "findings" in triage.result);
      triage.result.findings = [{}];
    },
    (s: Run) => {
      s.evidence = s.evidence.filter(
        (e: Evidence) => !(e.round === s.round && e.role === "triage"),
      );
      s.findings = [];
    },
  ]) {
    const s = structuredClone(valid);
    corrupt(s);
    const invalid = JSON.stringify(s);
    writeFileSync(path, invalid);
    assert.throws(() => new Store(f.store.dir), /invalid/i);
    assert.equal(readFileSync(path, "utf8"), invalid);
  }
});

test("final gate rejects current review blockers absent from findings", async (t) => {
  const f = fixture(t);
  const deliver = f.factory.delivery.deliver;
  f.factory.delivery.deliver = async (...args) => deliver(...args);
  await f.factory.plan("change", "github");
  const run = f.factory.agents.run.bind(f.factory.agents);
  f.factory.agents.run = async (...args) => {
    const result = await run(...args);
    if (args[0] === "triage") {
      const quality = present(
        present(f.store.state).evidence.find(
          (e) => e.role === "quality" && e.round === present(f.store.state).round,
        ),
      );
      assert.ok(
        quality.result && typeof quality.result === "object" && "findings" in quality.result,
      );
      assert.ok(Array.isArray(quality.result.findings));
      quality.result.findings.push({
        id: "hidden",
        blocking: true,
        evidence: "Hidden blocker",
      });
    }
    return result;
  };
  await f.factory.drive();
  assert.equal(present(f.store.state).phase, "blocked");
  assert.equal(present(f.store.state).pr, undefined);
});

test("local delivery persists selection and completes without GitHub", async (t) => {
  const f = fixture(t);
  f.factory.delivery.preflight = async () => {
    throw new Error("GitHub must not run");
  };
  f.factory.delivery.deliver = async () => {
    throw new Error("GitHub must not run");
  };
  await f.factory.request("change app", "local");
  const s = f.factory.state;
  assert.equal(s.phase, "completed", s.error);
  assert.equal(s.delivery, "local");
  assert.equal(s.target, undefined);
  assert.equal(s.pr, undefined);
  assert.deepEqual(s.localReceipt, {
    revision: s.revision,
    branch: s.branch,
    worktree: s.worktree,
  });
  assert.equal(git(present(s.worktree), "rev-parse", "HEAD"), s.revision);
  f.store.close();
  const reopened = new Store(f.store.dir);
  try {
    assert.deepEqual(reopened.state?.localReceipt, s.localReceipt);
  } finally {
    reopened.close();
  }
});

test("local persisted receipt fails closed when altered and preserves later worktree edits", async (t) => {
  const f = fixture(t);
  await f.factory.request("change", "local");
  const path = join(f.store.dir, "state.json");
  const original = readFileSync(path, "utf8");
  const worktree = present(f.factory.state.worktree);
  f.store.close();
  for (const mutate of [
    (s: Run) => {
      s.step = "implement";
      s.evidence = [];
    },
    (s: Run) => {
      delete s.localReceipt;
    },
    (s: Run) => {
      assert.ok(s.localReceipt);
      s.localReceipt.revision = "forged";
    },
    (s: Run) => {
      assert.ok(s.revision);
      s.pr = { url: "https://example.invalid", head: s.revision, draft: true };
    },
  ]) {
    const s = JSON.parse(original);
    mutate(s);
    const invalid = JSON.stringify(s);
    writeFileSync(path, invalid);
    assert.throws(() => new Store(f.store.dir), /invalid/i);
    assert.equal(readFileSync(path, "utf8"), invalid);
  }
  writeFileSync(path, original);
  writeFileSync(join(worktree, "app.txt"), "dirty");
  const reopened = new Store(f.store.dir);
  try {
    assert.equal(reopened.state?.phase, "completed");
    assert.equal(readFileSync(join(worktree, "app.txt"), "utf8"), "dirty");
    const factory = new Factory(reopened, new Git(f.repo), f.factory.agents, f.factory.delivery);
    await factory.plan("next", "local");
    assert.equal(readFileSync(join(f.repo, "app.txt"), "utf8"), "old");
    assert.equal(readFileSync(join(worktree, "app.txt"), "utf8"), "dirty");
  } finally {
    reopened.close();
  }
});

test("legacy missing mode stays GitHub and GitHub preflight never falls back", async (t) => {
  const f = fixture(t);
  f.factory.delivery.preflight = async () => {
    throw new Error("gh failed");
  };
  await assert.rejects(f.factory.plan("change", "github"), /gh failed/);
  assert.equal(f.store.state, undefined);
  await f.factory.plan("change", "local");
  f.store.close();
  const path = join(f.store.dir, "state.json");
  const s = JSON.parse(readFileSync(path, "utf8"));
  delete s.delivery;
  writeFileSync(path, JSON.stringify(s));
  assert.throws(() => new Store(f.store.dir), /invalid/i);
});

test("GitHub origin automatically preflights and never falls back to local delivery", async (t) => {
  const f = fixture(t);
  git(f.repo, "remote", "add", "origin", "https://github.com/example/repo.git");
  f.factory.delivery.preflight = async () => {
    throw new Error("GitHub unavailable");
  };
  await assert.rejects(f.factory.request("change"), /GitHub unavailable/);
  assert.equal(f.store.state, undefined);
  assert.deepEqual(f.calls, []);
  assert.equal(git(f.repo, "branch", "--show-current"), "main");
});

test("default delivery completes locally without GitHub preflight or delivery", async (t) => {
  const f = fixture(t);
  f.factory.delivery.preflight = async () => {
    throw new Error("unexpected GitHub preflight");
  };
  f.factory.delivery.deliver = async () => {
    throw new Error("unexpected GitHub delivery");
  };
  await f.factory.plan("change");
  assert.equal(f.factory.state.delivery, "local");
  await f.factory.drive();
  assert.equal(f.factory.state.phase, "completed", f.factory.state.error);
  assert.ok(f.factory.state.localReceipt);
  assert.equal(f.factory.state.pr, undefined);
});

test("command descriptions automatically select delivery", async (t) => {
  const { registerFactoryCommands } = await import("../src/commands.ts");
  // oxlint-disable no-await-in-loop -- Independent command requests are serialized.
  for (const [input, origin, mode] of [
    ["Build app", false, "local"],
    ["Build app", true, "github"],
    ["request Build app", false, "local"],
    ["--delivery github Build app", false, "local"],
    ["status improve app", false, "local"],
    ["pause improve app", false, "local"],
    ["resume improve app", false, "local"],
    ["cancel improve app", false, "local"],
    ["deliver improve app", false, "local"],
    ["report", false, "local"],
    ["inspect", false, "local"],
  ] as const) {
    const f = fixture(t);
    if (origin) {
      git(f.repo, "remote", "add", "origin", "https://github.com/example/repo.git");
    }
    let handler!: CommandHandler;
    registerFactoryCommands(
      {
        registerCommand(_name: string, command: Command) {
          handler = command.handler;
        },
        on() {},
      },
      async () => f.factory,
      () => {},
    );
    await handler(input, { ui: { notify() {} } });
    await waitFor(
      () => f.factory.state.phase === "completed" || f.factory.state.phase === "blocked",
    );
    assert.equal(f.factory.state.request, input);
    assert.equal(f.factory.state.delivery, mode);
    assert.equal(f.factory.state.phase, "completed", f.factory.state.error);
  }
  // oxlint-enable no-await-in-loop
});

test("local final test failure exhausts two repairs without delivery", async (t) => {
  const f = fixture(t, 99);
  await f.factory.plan("change", "local");
  await f.factory.drive();
  assert.equal(f.repairs(), 5);
  assert.equal(present(f.store.state).phase, "blocked");
  assert.equal(present(f.store.state).localReceipt, undefined);
});

test("unsupported origin fails without local fallback", async (t) => {
  const f = fixture(t);
  git(f.repo, "remote", "add", "origin", "https://gitlab.com/example/repo.git");
  await assert.rejects(f.factory.request("change"), /unsupported origin/i);
  assert.equal(f.store.state, undefined);
  assert.deepEqual(f.calls, []);
});

test("local confirmed review blocker exhausts repairs", async (t) => {
  const f = fixture(t);
  const run = f.factory.agents.run.bind(f.factory.agents);
  f.factory.agents.run = async (role, task, cwd, identity, signal) => {
    if (role === "quality") {
      return {
        summary: "Defect",
        coverage: ["app.txt"],
        findings: [{ id: "defect", blocking: true, evidence: "app.txt" }],
      };
    }
    if (role === "triage") {
      return {
        findings: [{ id: "quality:defect", blocking: true, confirmed: true, evidence: "app.txt" }],
        complete: true,
        completionEvidence: "Request complete",
        commitSubject: "fix: update app",
      };
    }
    return run(role, task, cwd, identity, signal);
  };
  await f.factory.plan("change", "local");
  await f.factory.drive();
  assert.equal(f.repairs(), 5);
  assert.equal(present(f.store.state).phase, "blocked");
  assert.equal(present(f.store.state).localReceipt, undefined);
});

test("local dirty review worktree cannot complete", async (t) => {
  const f = fixture(t);
  const run = f.factory.agents.run.bind(f.factory.agents);
  f.factory.agents.run = async (role, task, cwd, identity, signal) => {
    const result = await run(role, task, cwd, identity, signal);
    if (role === "quality") {
      writeFileSync(join(cwd, "app.txt"), "dirty");
    }
    return result;
  };
  await f.factory.plan("change", "local");
  await f.factory.drive();
  assert.equal(present(f.store.state).phase, "blocked");
  assert.equal(present(f.store.state).localReceipt, undefined);
});

test("legacy GitHub state without mode remains valid", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "github");
  f.store.close();
  const path = join(f.store.dir, "state.json");
  const s = JSON.parse(readFileSync(path, "utf8"));
  delete s.delivery;
  writeFileSync(path, JSON.stringify(s));
  const reopened = new Store(f.store.dir);
  try {
    assert.equal(present(reopened.state).delivery, undefined);
    assert.ok(present(reopened.state).target);
  } finally {
    reopened.close();
  }
});

test("persisted delivery mode rejects mismatched target and receipt", async (t) => {
  // oxlint-disable no-await-in-loop -- Each mode uses an independent store.
  for (const mode of ["local", "github"] as const) {
    const f = fixture(t);
    await f.factory.request("change", mode);
    const s = f.factory.state;
    assert.equal(s.phase, "completed", s.error);
    s.delivery = mode === "local" ? "github" : "local";
    f.store.save();
    f.store.close();
    assert.throws(() => new Store(f.store.dir), /invalid/i);
  }
  // oxlint-enable no-await-in-loop
});

test("legacy v2 GitHub state without mode remains runnable", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "github");
  f.factory.pause();
  const path = join(f.store.dir, "state.json");
  f.store.close();
  const s = JSON.parse(readFileSync(path, "utf8"));
  delete s.delivery;
  writeFileSync(path, JSON.stringify(s));
  const reopened = new Store(f.store.dir);
  try {
    const factory = new Factory(reopened, new Git(f.repo), f.factory.agents, f.factory.delivery);
    await factory.resume();
    await factory.drive();
    assert.equal(factory.state.phase, "completed", factory.state.error);
    assert.equal(factory.state.pr?.draft, true);
  } finally {
    reopened.close();
  }
});

test("delivery mode changed during an active run blocks before delivery", async (t) => {
  const f = fixture(t);
  let delivered = false;
  const run = f.factory.agents.run.bind(f.factory.agents);
  f.factory.agents.run = async (role, task, cwd, identity, signal) => {
    const result = await run(role, task, cwd, identity, signal);
    if (role === "tester") {
      f.factory.state.delivery = "github";
      f.factory.state.target = {
        repo: "example/repo",
        base: "main",
        remote: "https://github.com/example/repo.git",
      };
    }
    return result;
  };
  f.factory.delivery.deliver = async () => {
    delivered = true;
    throw new Error("must not deliver");
  };
  await f.factory.plan("change", "local");
  await f.factory.drive();
  assert.equal(f.factory.state.phase, "blocked");
  assert.equal(delivered, false);
  assert.equal(f.factory.state.localReceipt, undefined);
  assert.equal(f.factory.state.pr, undefined);
});

test("isolated checkout preserves original ignored configuration", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repo, ".git", "info", "exclude"), ".pi/\nnode_modules/\n");
  makeDirectory(join(f.repo, ".pi"));
  makeDirectory(join(f.repo, "node_modules"));
  writeFileSync(join(f.repo, ".pi", "marker"), "config");
  writeFileSync(join(f.repo, "node_modules", "marker"), "deps");
  const run = f.factory.agents.run;
  f.factory.agents.run = async (...args) => {
    assert.notEqual(args[2], f.repo);
    return run(...args);
  };
  await f.factory.request("change", "local");
  assert.equal(f.factory.state.phase, "completed", f.factory.state.error);
  assert.equal(git(f.repo, "branch", "--show-current"), "main");
  assert.equal(readFileSync(join(f.repo, ".pi", "marker"), "utf8"), "config");
  assert.equal(readFileSync(join(f.repo, "node_modules", "marker"), "utf8"), "deps");
  assert.equal(readFileSync(join(f.repo, "app.txt"), "utf8"), "old");
});

test("paused worktree edits and branch switches block resume without discarding data", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "local");
  f.factory.pause();
  const worktree = present(f.factory.state.worktree);
  writeFileSync(join(worktree, "app.txt"), "manual");
  await assert.rejects(f.factory.resume(), /changed|snapshot/i);
  assert.equal(readFileSync(join(worktree, "app.txt"), "utf8"), "manual");
  git(worktree, "add", "app.txt");
  git(worktree, "commit", "-m", "manual");
  git(worktree, "switch", "--detach");
  await assert.rejects(f.factory.resume(), /branch|HEAD|revision/i);
  assert.equal(git(worktree, "show", f.factory.state.branch + ":app.txt"), "manual");
});

test("paused checkout without a snapshot requires inspected recovery", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "local");
  f.factory.pause();
  const path = join(f.store.dir, "state.json");
  f.store.close();
  const s = JSON.parse(readFileSync(path, "utf8"));
  delete s.pauseSnapshot;
  writeFileSync(path, JSON.stringify(s));
  const reopened = new Store(f.store.dir);
  try {
    const factory = new Factory(reopened, new Git(f.repo), f.factory.agents, f.factory.delivery);
    await assert.rejects(factory.resume(), /snapshot unavailable; inspect and replan/);
    assert.equal(factory.state.paused, true);
  } finally {
    reopened.close();
  }
});

test("legacy execution location cannot be resumed", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "local");
  f.factory.pause();
  delete f.factory.state.location;
  await assert.rejects(f.factory.resume(), /legacy execution location/i);
});

test("paused worktree edits prevent automatic resume and remain intact", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "local");
  f.factory.pause();
  const path = join(present(f.factory.state.worktree), "app.txt");
  writeFileSync(path, "manual");
  await assert.rejects(f.factory.resume(), /changed|snapshot/i);
  assert.equal(readFileSync(path, "utf8"), "manual");
  assert.equal(f.factory.state.paused, true);
});

test("worktree creation interruption remains loadable and uncertain before and after creation", async (t) => {
  // oxlint-disable no-await-in-loop -- Each interrupted operation uses an independent store.
  for (const after of [false, true]) {
    const f = fixture(t);
    const create = f.factory.git.create.bind(f.factory.git);
    f.factory.git.create = (s) => {
      if (after) {
        create(s);
      }
      throw new Error("interrupted");
    };
    await assert.rejects(f.factory.request("change", "local"), /interrupted/);
    assert.equal(f.factory.state.active?.role, "worktree-create");
    f.store.close();
    const reopened = new Store(f.store.dir);
    try {
      assert.equal(reopened.state?.phase, "blocked");
      assert.equal(reopened.state?.active?.role, "worktree-create");
      await assert.rejects(
        new Factory(reopened, new Git(f.repo), f.factory.agents, f.factory.delivery).resume(),
        /uncertain/i,
      );
      assert.equal(git(f.repo, "branch", "--show-current"), "main");
      if (after) {
        assert.ok(git(f.repo, "worktree", "list").includes(present(reopened.state?.branch)));
      }
    } finally {
      reopened.close();
    }
  }
  // oxlint-enable no-await-in-loop
});

test("interrupted finalization preserves durable intent and files before and after commit", async (t) => {
  for (const afterCommit of [false, true]) {
    const f = fixture(t);
    const finalize = f.factory.git.finalize.bind(f.factory.git);
    f.factory.git.finalize = (...args) => {
      if (afterCommit) {
        finalize(...args);
      }
      throw new Error("commit interrupted");
    };
    // oxlint-disable-next-line no-await-in-loop -- Each independent interruption must finish before reopening its store.
    await f.factory.request("change", "local");
    const state = f.factory.state;
    const worktree = present(state.worktree);
    assert.equal(state.phase, "blocked");
    assert.equal(state.active?.role, "finalize");
    assert.equal(readFileSync(join(worktree, "app.txt"), "utf8"), "new");
    assert.equal(
      git(worktree, "rev-list", "--count", `${state.baseRevision}..HEAD`),
      afterCommit ? "1" : "0",
    );
    f.store.close();
    const reopened = new Store(f.store.dir);
    try {
      assert.equal(reopened.state?.active?.role, "finalize");
      assert.equal(reopened.state?.phase, "blocked");
      assert.equal(readFileSync(join(worktree, "app.txt"), "utf8"), "new");
    } finally {
      reopened.close();
    }
  }
});

test("ignored dependency edits do not invalidate paused candidate snapshot", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repo, ".git", "info", "exclude"), "node_modules/\n");
  await f.factory.plan("change", "local");
  const worktree = present(f.factory.state.worktree);
  makeDirectory(join(worktree, "node_modules"));
  writeFileSync(join(worktree, "node_modules", "dep"), "one");
  f.factory.pause();
  writeFileSync(join(worktree, "node_modules", "dep"), "two");
  await f.factory.resume();
  assert.equal(readFileSync(join(worktree, "node_modules", "dep"), "utf8"), "two");
});

test("pause snapshot is captured after worker generated ignored files settle", async (t) => {
  const f = fixture(t);
  const { mkdirSync } = await import("node:fs");
  writeFileSync(join(f.repo, ".git", "info", "exclude"), "node_modules/\n");
  mkdirSync(join(f.repo, "node_modules"));
  const run = f.factory.agents.run;
  f.factory.agents.run = async (...args) => {
    const result = await run(...args);
    if (args[0] === "worker") {
      writeFileSync(join(f.repo, "node_modules", "generated"), "built");
      f.factory.pause();
    }
    return result;
  };
  await f.factory.plan("change", "local");
  await f.factory.drive();
  assert.equal(f.factory.state.paused, true);
  await f.factory.resume();
  assert.equal(f.factory.state.paused, false);
});

test("paused before finalization reopens and reruns all final gates", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "local");
  f.factory.changed = (s) => {
    if (s.step === "deliver" && !s.paused) {
      f.factory.pause();
    }
  };
  await f.factory.drive();
  assert.equal(f.factory.state.paused, true);
  const round = f.factory.state.round;
  f.store.close();
  const reopened = new Store(f.store.dir);
  try {
    const factory = new Factory(reopened, new Git(f.repo), f.factory.agents, f.factory.delivery);
    await factory.resume();
    await factory.drive();
    assert.equal(factory.state.phase, "completed", factory.state.error);
    assert.ok(factory.state.round > round);
    assert.ok(
      factory.state.evidence.some((e) => e.role === "tester" && e.round === factory.state.round),
    );
  } finally {
    reopened.close();
  }
});

test("persisted optional object fields reject non-objects without rewriting state", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "github");
  f.store.close();
  const path = join(f.store.dir, "state.json");
  const valid = JSON.parse(readFileSync(path, "utf8"));
  for (const key of ["active", "pr", "localReceipt"]) {
    const invalid = JSON.stringify({ ...valid, [key]: false });
    writeFileSync(path, invalid);
    assert.throws(() => new Store(f.store.dir), /invalid/i);
    assert.equal(readFileSync(path, "utf8"), invalid);
  }
});

test("interrupted planner preserves uncertain operation and checkout", async (t) => {
  const f = fixture(t);
  f.factory.agents.run = async () => {
    throw new Error("planner interrupted");
  };
  await assert.rejects(f.factory.request("change", "local"), /interrupted/);
  const s = f.factory.state;
  assert.equal(s.active?.role, "planner");
  await assert.rejects(f.factory.request("another", "local"), /uncertain/);
  await assert.rejects(f.factory.resume(), /uncertain/i);
  assert.equal(readFileSync(join(present(s.worktree), "app.txt"), "utf8"), "old");
  f.store.close();
  const reopened = new Store(f.store.dir);
  try {
    assert.equal(reopened.state?.active?.role, "planner");
    assert.equal(reopened.state?.phase, "blocked");
  } finally {
    reopened.close();
  }
});

test("invalid or mutating planner cannot execute and preserves isolated checkout", async (t) => {
  // oxlint-disable no-await-in-loop -- Each planner failure uses an independent run.
  for (const failure of ["invalid plan", "changed checkout"] as const) {
    const f = fixture(t);
    f.factory.agents.run = async (_role, _task, cwd) => {
      if (failure === "invalid plan") {
        return { ...f.plan, tasks: [] };
      }
      writeFileSync(join(cwd, "app.txt"), "planner change");
      return f.plan;
    };
    await assert.rejects(f.factory.request("change", "local"));
    assert.equal(f.factory.state.phase, "failed");
    assert.equal(f.factory.state.pr, undefined);
    assert.equal(readFileSync(join(f.repo, "app.txt"), "utf8"), "old");
    assert.equal(
      readFileSync(join(present(f.factory.state.worktree), "app.txt"), "utf8"),
      failure === "changed checkout" ? "planner change" : "old",
    );
  }
  // oxlint-enable no-await-in-loop
});

test("staged ignored file is reviewed, snapshotted and included in final commit", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repo, ".gitignore"), "fixture.txt\n");
  git(f.repo, "add", ".gitignore");
  git(f.repo, "commit", "-m", "ignore fixture");
  f.plan.files.push("fixture.txt");
  const run = f.factory.agents.run;
  f.factory.agents.run = async (...args) => {
    if (args[0] === "worker") {
      const before = f.factory.git.snapshot(f.factory.state);
      writeFileSync(join(args[2], "fixture.txt"), "staged fixture\n");
      git(args[2], "add", "-f", "fixture.txt");
      assert.notEqual(f.factory.git.snapshot(f.factory.state), before);
      return { summary: "staged fixture", scopeChange: "" };
    }
    return run(...args);
  };
  await f.factory.request("add ignored fixture", "local");
  const s = f.factory.state;
  assert.equal(s.phase, "completed", s.error);
  assert.equal(git(present(s.worktree), "show", "HEAD:fixture.txt"), "staged fixture");
  const material = readFileSync(join(f.store.dir, `review-${s.id}-${s.round}.md`), "utf8");
  assert.match(material, /fixture\.txt/);
  assert.match(material, /\+staged fixture/);
  assert.ok(s.reviewPaths?.includes("fixture.txt"));
});

test("review material rejects lines beyond Pi read's 50 KiB limit", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "local");
  const worktree = present(f.factory.state.worktree);
  const path = join(worktree, "large.txt");
  writeFileSync(path, "x".repeat(50 * 1024));
  assert.ok(f.factory.git.reviewText(f.factory.state).includes("x".repeat(50 * 1024)));
  writeFileSync(path, "x".repeat(50 * 1024 + 1));
  assert.throws(() => f.factory.git.reviewText(f.factory.state), /overlong line.*unsupported/i);
  writeFileSync(path, "é".repeat(25 * 1024 + 1));
  assert.throws(() => f.factory.git.reviewText(f.factory.state), /overlong line.*unsupported/i);
});

test("triage receives bounded prompts and paged complete command output artifacts", async (t) => {
  const f = fixture(t);
  f.plan.verification[0] = {
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write('x'.repeat(3000000)); process.stderr.write('y'.repeat(10000))",
    ],
    purpose: "Verbose verification",
  };
  const run = f.factory.agents.run;
  let checked = false;
  f.factory.agents.run = async (...args) => {
    if (args[0] === "triage") {
      assert.ok(Buffer.byteLength(args[1]) < 50000);
      const match = /Verification and review status: (\[.*?\])\. Command output artifacts/.exec(
        args[1],
      );
      assert.ok(match);
      const statuses = JSON.parse(present(match[1])) as {
        role: string;
        code?: number;
        artifact?: string;
      }[];
      const command = present(statuses.find((item) => item.role === "command"));
      assert.equal(command.code, 0);
      const lines = readFileSync(present(command.artifact), "utf8").trimEnd().split("\n");
      assert.ok(lines.every((line) => Buffer.byteLength(line) <= 50 * 1024));
      const chunks = lines.map(
        (line) => JSON.parse(line) as { stream: string; offset: number; text: string },
      );
      for (const [stream, expected] of [
        ["stdout", "x".repeat(3000000)],
        ["stderr", "y".repeat(10000)],
      ] as const) {
        let output = "";
        for (const chunk of chunks.filter((item) => item.stream === stream)) {
          assert.equal(chunk.offset, output.length);
          output += chunk.text;
        }
        assert.equal(output, expected);
      }
      checked = true;
    }
    return run(...args);
  };
  await f.factory.request("change", "local");
  assert.equal(f.factory.state.phase, "completed", f.factory.state.error);
  assert.equal(checked, true);
});

test("non-GitHub origin paths are rejected without delivery", async (t) => {
  // oxlint-disable no-await-in-loop -- Each origin is tested in an independent repository.
  for (const origin of [
    "/srv/mirrors/github.com/owner/repo.git",
    "https://gitlab.example/team/github.com/repo.git",
  ]) {
    const f = fixture(t);
    git(f.repo, "remote", "add", "origin", origin);
    f.factory.delivery.preflight = async () => {
      throw new Error("unexpected GitHub preflight");
    };
    await assert.rejects(f.factory.plan("change"), /unsupported origin/i);
    assert.equal(f.store.state, undefined);
    assert.deepEqual(f.calls, []);
  }
  // oxlint-enable no-await-in-loop
});

test("incomplete final triage triggers repair and reruns all gates before delivery", async (t) => {
  const f = fixture(t);
  const run = f.factory.agents.run;
  let triages = 0;
  f.factory.agents.run = async (...args) => {
    if (args[0] === "triage" && ++triages === 1) {
      assert.equal(git(args[2], "rev-parse", "HEAD"), f.factory.state.baseRevision);
      assert.equal(f.factory.state.localReceipt, undefined);
      return {
        findings: [],
        complete: false,
        completionEvidence: "Missing required behavior",
        commitSubject: "fix: update app",
      };
    }
    return run(...args);
  };
  await f.factory.request("change", "local");
  const s = f.factory.state;
  assert.equal(s.phase, "completed", s.error);
  assert.equal(f.repairs(), 1);
  assert.equal(triages, 2);
  assert.ok(
    s.evidence.some(
      (e) =>
        e.role === "triage" &&
        e.round === 1 &&
        (e.result as { complete: boolean }).complete === false,
    ),
  );
  for (const role of ["tester", "quality", "security", "ponytail", "docs", "triage"]) {
    assert.ok(
      s.evidence.some((e) => e.role === role && e.round === 2),
      role,
    );
  }
});

test("delivery-only local retry reopens final intent without agents or another commit", async (t) => {
  const f = fixture(t);
  const save = f.store.save.bind(f.store);
  let fail = true;
  f.store.save = () => {
    if (fail && f.factory.state.localReceipt) {
      fail = false;
      throw new Error("receipt save interrupted");
    }
    save();
  };
  await f.factory.request("change", "local");
  const s = f.factory.state;
  assert.equal(s.phase, "blocked");
  const calls = [...f.calls];
  const revision = present(s.revision);
  f.store.close();
  const reopened = new Store(f.store.dir);
  try {
    const factory = new Factory(reopened, new Git(f.repo), f.factory.agents, f.factory.delivery);
    await assert.rejects(factory.resume(), /uncertain/i);
    const subject = git(present(s.worktree), "log", "-1", "--format=%s");
    await factory.deliver();
    assert.equal(factory.state.phase, "completed");
    assert.equal(factory.state.localReceipt?.revision, revision);
    assert.equal(git(present(s.worktree), "log", "-1", "--format=%s"), subject);
    await factory.deliver();
    assert.deepEqual(f.calls, calls);
    assert.equal(git(present(s.worktree), "rev-list", "--count", `${s.baseRevision}..HEAD`), "1");
    assert.match(readFileSync(join(f.store.dir, "report.md"), "utf8"), /outcome: completed/);
  } finally {
    reopened.close();
  }
});

test("delivery-only rejects dirty workspace, missing evidence, and uncertain child", async (t) => {
  const f = fixture(t);
  f.factory.delivery.deliver = async () => {
    throw new Error("push interrupted");
  };
  await f.factory.request("change", "github");
  const s = f.factory.state;
  const revision = present(s.revision);
  s.revision = s.baseRevision;
  s.deliveryIntent = s.baseRevision;
  await assert.rejects(f.factory.deliver());
  s.revision = revision;
  s.deliveryIntent = revision;
  const evidence = s.evidence;
  s.evidence = [];
  await assert.rejects(f.factory.deliver());
  s.evidence = evidence;
  const worktree = present(s.worktree);
  s.worktree = f.repo;
  await assert.rejects(f.factory.deliver());
  s.worktree = worktree;
  git(worktree, "switch", "--detach");
  await assert.rejects(f.factory.deliver());
  git(worktree, "switch", s.branch);
  s.active = { role: "worker", requestId: "uncertain", started: Date.now() };
  await assert.rejects(f.factory.deliver(), /uncertain child/);
  s.active = undefined;
  writeFileSync(join(present(s.worktree), "app.txt"), "dirty");
  await assert.rejects(f.factory.deliver(), /dirty/);
  assert.equal(readFileSync(join(present(s.worktree), "app.txt"), "utf8"), "dirty");
  assert.equal(s.phase, "blocked");
  rmSync(worktree, { recursive: true, force: true });
  await assert.rejects(f.factory.deliver());
});

test("GitHub delivery publishes an unpublished local branch onto the default base", async (t) => {
  const { chmodSync } = await import("node:fs");
  const f = fixture(t);
  const bare = join(f.root, "remote.git");
  git(f.root, "init", "--bare", bare);
  git(f.repo, "push", bare, "main");
  const remoteBase = git(f.repo, "rev-parse", "HEAD");
  git(f.repo, "switch", "-c", "unpublished");
  writeFileSync(join(f.repo, "local.txt"), "local commit\n");
  git(f.repo, "add", "local.txt");
  git(f.repo, "commit", "-m", "local change");
  const localHead = git(f.repo, "rev-parse", "HEAD");
  git(f.repo, "remote", "add", "origin", "https://github.com/example/repo.git");
  git(f.repo, "config", `url.${bare}.pushInsteadOf`, "https://github.com/example/repo.git");
  const bin = join(f.root, "bin");
  makeDirectory(bin);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const prFile = join(f.root, "pr.json");
  writeFileSync(
    join(bin, "git"),
    `#!${process.execPath}
const cp=require('node:child_process'),a=process.argv.slice(2); if(a[0]==='ls-remote') a[2]=${JSON.stringify(bare)}; const r=cp.spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'}); process.exit(r.status??1);
`,
  );
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process'),a=process.argv.slice(2),file=${JSON.stringify(prFile)};
if(a[0]==='auth') console.log('ok');
else if(a[0]==='repo') console.log(JSON.stringify({nameWithOwner:'example/repo',defaultBranchRef:{name:'main'},isArchived:false,viewerPermission:'WRITE'}));
else if(a[0]==='api'&&a[1].includes('/rules/')) console.log('[]');
else if(a[0]==='api'&&a[1].endsWith('/branches/main')) console.log(JSON.stringify({commit:{sha:${JSON.stringify(remoteBase)}}}));
else if(a[0]==='pr'&&a[1]==='list') console.log('[]');
else if(a[0]==='pr'&&a[1]==='create') { const base=a[a.indexOf('--base')+1],branch=a[a.indexOf('--head')+1],sha=cp.execFileSync(${JSON.stringify(realGit)},['--git-dir',${JSON.stringify(bare)},'rev-parse','refs/heads/'+branch],{encoding:'utf8'}).trim(); fs.writeFileSync(file,JSON.stringify({url:'https://github.com/example/repo/pull/1',isDraft:a.includes('--draft'),headRefName:branch,headRefOid:sha,baseRefName:base})); console.log('https://github.com/example/repo/pull/1'); }
else if(a[0]==='pr'&&a[1]==='view') console.log(fs.readFileSync(file,'utf8')); else process.exit(1);
`,
  );
  chmodSync(join(bin, "git"), 0o755);
  chmodSync(join(bin, "gh"), 0o755);
  const oldPath = process.env.PATH;
  t.after(() => {
    if (oldPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = oldPath;
    }
  });
  process.env.PATH = bin + ":" + oldPath;
  f.factory.delivery = new PreflightDelivery(f.factory.git, f.store.dir);
  await f.factory.request("change app", "github");
  const s = f.factory.state;
  assert.equal(s.phase, "completed", s.error);
  assert.equal(s.baseRevision, localHead);
  assert.equal(s.target?.base, "main");
  assert.equal(s.target?.baseRevision, remoteBase);
  assert.equal(git(f.repo, "rev-parse", "HEAD"), localHead);
  assert.equal(git(present(s.worktree), "rev-list", "--count", `${localHead}..HEAD`), "1");
  assert.equal(git(f.root, "--git-dir", bare, "rev-parse", `refs/heads/${s.branch}`), s.revision);
  assert.equal(
    git(f.root, "--git-dir", bare, "rev-list", "--count", `${remoteBase}..${s.branch}`),
    "2",
  );
  assert.equal(s.pr?.url, "https://github.com/example/repo/pull/1");
  assert.equal(JSON.parse(readFileSync(prFile, "utf8")).baseRefName, "main");
});

test("delivery-only reconciles local remote and interrupted PR creation without duplicate", async (t) => {
  const { chmodSync } = await import("node:fs");
  const f = fixture(t);
  const bare = join(f.root, "remote.git");
  git(f.root, "init", "--bare", bare);
  git(f.repo, "remote", "add", "origin", "https://github.com/example/repo.git");
  git(f.repo, "config", `url.${bare}.pushInsteadOf`, "https://github.com/example/repo.git");
  const bin = join(f.root, "bin");
  makeDirectory(bin);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const prFile = join(f.root, "pr.json"),
    log = join(f.root, "calls");
  writeFileSync(
    join(bin, "git"),
    `#!${process.execPath}
const cp=require('node:child_process'),fs=require('node:fs'),a=process.argv.slice(2); if(a[0]==='ls-remote') a[2]=process.env.TEST_RETRY_BARE; if(a.includes('push')) {fs.appendFileSync(process.env.TEST_RETRY_LOG,'push\\n'); if(process.env.TEST_RETRY_PUSH_FAIL) process.exit(1);} const r=cp.spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});process.exit(r.status??1);
`,
  );
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process'),a=process.argv.slice(2),file=process.env.TEST_RETRY_PR;
if(a[0]==='auth') console.log('ok');
else if(a[0]==='repo') console.log(JSON.stringify({nameWithOwner:'example/repo',defaultBranchRef:{name:'main'},isArchived:false,viewerPermission:'WRITE'}));
else if(a[0]==='api'&&a[1].includes('/rules/')) console.log('[]');
else if(a[0]==='api') console.log(JSON.stringify({commit:{sha:process.env.TEST_RETRY_BASE}}));
else if(a[0]==='pr'&&a[1]==='list') console.log(fs.existsSync(file)?'['+fs.readFileSync(file)+']':'[]');
else if(a[0]==='pr'&&a[1]==='create') {fs.appendFileSync(process.env.TEST_RETRY_LOG,'create\\n'); if(process.env.TEST_RETRY_NO_PR) process.exit(1); const [branch,sha]=cp.execFileSync(${JSON.stringify(realGit)},['--git-dir',process.env.TEST_RETRY_BARE,'for-each-ref','--format=%(refname:short) %(objectname)','refs/heads/factory/'],{encoding:'utf8'}).trim().split(' '); fs.writeFileSync(file,JSON.stringify({url:'https://github.com/example/repo/pull/1',state:'OPEN',isDraft:true,headRefName:branch,headRefOid:sha,baseRefName:'main',headRepository:{nameWithOwner:'example/repo'}})); if(process.env.TEST_RETRY_INTERRUPT) process.exit(1); console.log('https://github.com/example/repo/pull/1');}
else if(a[0]==='pr'&&a[1]==='view') console.log(fs.readFileSync(file,'utf8')); else process.exit(1);
`,
  );
  chmodSync(join(bin, "git"), 0o755);
  chmodSync(join(bin, "gh"), 0o755);
  const keys = [
    "PATH",
    "TEST_RETRY_BARE",
    "TEST_RETRY_LOG",
    "TEST_RETRY_PR",
    "TEST_RETRY_BASE",
    "TEST_RETRY_INTERRUPT",
    "TEST_RETRY_NO_PR",
    "TEST_RETRY_PUSH_FAIL",
  ];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      const value = old[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
  process.env.PATH = bin + ":" + old.PATH;
  process.env.TEST_RETRY_BARE = bare;
  process.env.TEST_RETRY_LOG = log;
  process.env.TEST_RETRY_PR = prFile;
  process.env.TEST_RETRY_BASE = git(f.repo, "rev-parse", "HEAD");
  f.factory.delivery.deliver = async () => {
    throw new Error("initial delivery interrupted");
  };
  await f.factory.request("change", "github");
  f.factory.delivery = new PreflightDelivery(f.factory.git, f.store.dir);
  const s = f.factory.state,
    calls = [...f.calls];
  process.env.TEST_RETRY_PUSH_FAIL = "1";
  await assert.rejects(f.factory.deliver(), /Push failed/);
  delete process.env.TEST_RETRY_PUSH_FAIL;
  git(f.root, "--git-dir", bare, "fetch", f.repo, s.baseRevision);
  git(f.root, "--git-dir", bare, "update-ref", `refs/heads/${s.branch}`, s.baseRevision);
  await assert.rejects(f.factory.deliver(), /Remote factory branch already exists/);
  git(f.root, "--git-dir", bare, "update-ref", "-d", `refs/heads/${s.branch}`);
  process.env.TEST_RETRY_BASE = present(s.revision);
  await assert.rejects(f.factory.deliver(), /base moved/);
  process.env.TEST_RETRY_BASE = s.baseRevision;
  process.env.TEST_RETRY_NO_PR = "1";
  await assert.rejects(f.factory.deliver(), /GitHub CLI failed/);
  assert.equal(existsSync(prFile), false);
  delete process.env.TEST_RETRY_NO_PR;
  process.env.TEST_RETRY_INTERRUPT = "1";
  await assert.rejects(f.factory.deliver(), /GitHub CLI failed/);
  assert.equal(s.phase, "blocked");
  assert.ok(existsSync(prFile));
  delete process.env.TEST_RETRY_INTERRUPT;
  const pr = JSON.parse(readFileSync(prFile, "utf8"));
  for (const [key, value] of [
    ["state", "CLOSED"],
    ["baseRefName", "other"],
    ["headRefName", "other"],
    ["headRefOid", s.baseRevision],
    ["headRepository", { nameWithOwner: "other/repo" }],
  ] as const) {
    writeFileSync(prFile, JSON.stringify({ ...pr, [key]: value }));
    // oxlint-disable-next-line no-await-in-loop -- Each conflicting PR is checked independently.
    await assert.rejects(f.factory.deliver(), /Existing PR does not match/);
  }
  writeFileSync(prFile, JSON.stringify({ ...pr, isDraft: false }));
  f.store.close();
  const reopened = new Store(f.store.dir);
  try {
    const factory = new Factory(
      reopened,
      new Git(f.repo),
      f.factory.agents,
      new PreflightDelivery(new Git(f.repo), f.store.dir),
    );
    const save = reopened.save.bind(reopened);
    let fail = true;
    reopened.save = () => {
      if (fail && factory.state.pr && factory.state.deliveryIntent) {
        fail = false;
        throw new Error("receipt save interrupted");
      }
      save();
    };
    await assert.rejects(factory.deliver(), /receipt save interrupted/);
    assert.equal(factory.state.phase, "blocked");
    await factory.deliver();
    assert.equal(factory.state.phase, "completed");
    assert.equal(factory.state.pr?.draft, false);
    await factory.deliver();
    assert.equal(readFileSync(log, "utf8").split("create\n").length - 1, 2);
    assert.equal(readFileSync(log, "utf8").split("push\n").length - 1, 2);
    assert.deepEqual(f.calls, calls);
    assert.equal(git(present(s.worktree), "rev-list", "--count", `${s.baseRevision}..HEAD`), "1");
  } finally {
    reopened.close();
  }
});

test("factory deliver command invokes only delivery retry", async (t) => {
  const { registerFactoryCommands } = await import("../src/commands.ts");
  const f = fixture(t);
  await f.factory.request("change", "local");
  const calls = [...f.calls];
  let handler!: CommandHandler;
  const notices: string[] = [];
  registerFactoryCommands(
    {
      registerCommand(_name: string, command: Command) {
        handler = command.handler;
      },
      on() {},
    },
    async () => f.factory,
    () => {},
  );
  const ctx = {
    ui: {
      notify(message: string) {
        notices.push(message);
      },
    },
  };
  await handler("deliver", ctx);
  await waitFor(() => notices.some((message) => message.includes("outcome: completed")));
  assert.deepEqual(f.calls, calls);
});

test("schema-backed reviews cover 65 changed paths", async (t) => {
  const f = fixture(t);
  f.plan.files = ["files/"];
  const run = f.factory.agents.run.bind(f.factory.agents);
  f.factory.agents.run = async (...args) => {
    if (args[0] === "worker") {
      makeDirectory(join(args[2], "files"));
      for (let i = 0; i < 65; i++) {
        writeFileSync(join(args[2], "files", `file-${i}.txt`), "new");
      }
      return { summary: "Done", scopeChange: "" };
    }
    const result = await run(...args);
    if (["quality", "security", "ponytail"].includes(args[0])) {
      assert.ok(Value.Check(present(roles[args[0]]).schema as never, result));
      assert.equal((result as { coverage: string[] }).coverage.length, 65);
    }
    return result;
  };
  await f.factory.request("change", "local");
  assert.equal(f.factory.state.phase, "completed", f.factory.state.error);
});

test("triage accepts all reviewer findings plus documentation finding", async (t) => {
  const f = fixture(t);
  const run = f.factory.agents.run.bind(f.factory.agents);
  let docs = 0,
    triages = 0;
  f.factory.agents.run = async (...args) => {
    if (["quality", "security", "ponytail"].includes(args[0])) {
      return {
        summary: "review",
        coverage: ["app.txt"],
        findings: Array.from({ length: 64 }, (_, i) => ({
          id: `f${i}`,
          blocking: false,
          evidence: "source",
        })),
      };
    }
    if (args[0] === "docs") {
      return { summary: "docs", changes: ++docs === 1 };
    }
    if (args[0] === "triage") {
      const result = (await run(...args)) as {
        findings: EvidenceFinding[];
        complete: boolean;
        completionEvidence: string;
        commitSubject: string;
      };
      triages++;
      assert.equal(result.findings.length, triages === 1 ? 193 : 192);
      assert.ok(Value.Check(present(roles.triage).schema as never, result));
      return result;
    }
    return run(...args);
  };
  await f.factory.request("change", "local");
  assert.equal(f.factory.state.phase, "completed", f.factory.state.error);
  assert.equal(triages, 2);
});

test("delivery retry resumes a safe paused finalized candidate", async (t) => {
  const f = fixture(t);
  f.factory.delivery.deliver = async (_s, _report, boundary) => {
    f.factory.pause();
    boundary();
    throw new Error("unreachable");
  };
  await f.factory.request("change", "github");
  const s = f.factory.state,
    calls = [...f.calls],
    revision = s.revision;
  assert.equal(s.paused, true);
  assert.match(f.factory.report(), /delivery failed.*paused/);
  assert.match(status(s), /blocked.*delivery failed.*paused/);
  const snapshot = s.pauseSnapshot;
  s.pauseSnapshot = "0".repeat(64);
  await assert.rejects(f.factory.deliver(), /Paused checkout changed/);
  assert.equal(s.paused, true);
  s.pauseSnapshot = snapshot;
  f.factory.delivery.reconcile = async (state, boundary) => {
    boundary();
    return {
      url: "https://github.com/example/repo/pull/1",
      head: present(state.revision),
      draft: true,
    };
  };
  await f.factory.deliver();
  assert.equal(s.phase, "completed");
  assert.equal(s.paused, false);
  assert.equal(s.revision, revision);
  assert.deepEqual(f.calls, calls);
  assert.equal(git(present(s.worktree), "rev-list", "--count", `${s.baseRevision}..HEAD`), "1");
});

test("cancelled report retains phase and cancellation", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "local");
  f.factory.cancel();
  assert.match(f.factory.report(), /blocked.*cancelled/);
  assert.match(status(f.factory.state), /blocked.*cancelled/);
});

test("worktree ownership supports symlinked state directory", async (t) => {
  const f = fixture(t);
  const target = join(f.root, "git-state");
  makeDirectory(target);
  symlinkSync(target, join(f.repo, ".git", "pi-factory"));
  await f.factory.request("change", "local");
  assert.equal(f.factory.state.phase, "completed", f.factory.state.error);
  assert.ok(f.factory.git.snapshot(f.factory.state));
});

test("cancellation confirmation follows successful settlement and persistence", async () => {
  const { registerFactoryCommands } = await import("../src/commands.ts");
  let handler!: CommandHandler;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const messages: string[] = [];
  const notices: string[] = [];
  const state = { cancelled: false, phase: "blocked" };
  const factory = {
    state,
    report: () => "artifacts",
    cancel: () => {
      state.cancelled = true;
    },
    request: () => gate,
  } as unknown as Factory;
  registerFactoryCommands(
    {
      registerCommand(_name: string, command: Command) {
        handler = command.handler;
      },
      on() {},
      sendMessage(message) {
        messages.push(message.content);
      },
    },
    async () => factory,
    () => {},
  );
  const ctx = {
    ui: {
      notify(message: string) {
        notices.push(message);
      },
    },
  };
  await handler("work", ctx);
  await handler("cancel", ctx);
  assert.ok(notices.some((n) => n.includes("Cancellation requested")));
  assert.equal(messages.length, 0);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(messages[0]!, /was cancelled.*Artifacts are retained/s);
  await handler("cancel", ctx);
  assert.equal(messages.length, 2);
});

test("planning rejects malformed or mutating challenger output", async (t) => {
  for (const mode of ["malformed", "mutation", "empty rejection"]) {
    await t.test(mode, async (t) => {
      const f = fixture(t);
      const run = f.factory.agents.run;
      f.factory.agents.run = async (...args) => {
        if (args[0] !== "challenger") {
          return run(...args);
        }
        f.calls.push("challenger");
        if (mode === "mutation") {
          writeFileSync(join(args[2], "app.txt"), "unauthorized");
        }
        return mode === "malformed"
          ? { approved: "yes", findings: [] }
          : { approved: mode !== "empty rejection", findings: [] };
      };
      await f.factory.request("change app", "local");
      assert.notEqual(f.store.state?.phase, "completed");
      assert.match(
        f.store.state?.error ?? "",
        /Invalid planning review|Challenger changed worktree/,
      );
      assert.ok(!f.calls.includes("worker"));
    });
  }
});

test("planning rejects revision path expansion or removal of verification", async (t) => {
  for (const mode of ["paths", "verification"]) {
    await t.test(mode, async (t) => {
      const f = fixture(t);
      f.plan.verification.push({ command: "true", args: [], purpose: "Second check" });
      const run = f.factory.agents.run;
      let planners = 0;
      f.factory.agents.run = async (...args) => {
        if (args[0] === "challenger") {
          f.calls.push("challenger");
          return { approved: false, findings: ["Revise"] };
        }
        if (args[0] === "planner" && ++planners === 2) {
          f.calls.push("planner");
          return {
            ...f.plan,
            ...(mode === "paths"
              ? { files: ["other.txt"] }
              : { verification: f.plan.verification.slice(0, 1) }),
          };
        }
        return run(...args);
      };
      await f.factory.request("change app", "local");
      assert.notEqual(f.store.state?.phase, "completed");
      assert.ok(!f.calls.includes("worker"));
      assert.equal(f.store.state?.plans.length, 1);
    });
  }
});

test("persisted planning boundaries resume without replaying completed reviews", async (t) => {
  for (const boundary of ["review", "revise", "approved", "exhausted", "active"] as const) {
    await t.test(boundary, async (t) => {
      const f = fixture(t);
      await f.factory.plan("change app", "local");
      const s = f.factory.state;
      s.phase = "planning";
      const rejected = { planRevision: 1, approved: false, findings: ["risk"] };
      if (boundary === "revise") {
        s.planning = { next: "revise", reviews: [rejected], unresolved: [] };
      }
      if (boundary === "approved") {
        s.planning = {
          next: "approved",
          reviews: [{ planRevision: 1, approved: true, findings: [] }],
          unresolved: [],
        };
      }
      if (boundary === "exhausted") {
        s.plans.push(structuredClone(s.plans[0]!), structuredClone(s.plans[0]!));
        s.planRevision = 3;
        s.planning = {
          next: "exhausted",
          reviews: [rejected, { ...rejected, planRevision: 2 }, { ...rejected, planRevision: 3 }],
          unresolved: ["risk"],
        };
      }
      if (boundary === "active") {
        s.active = { role: "challenger", requestId: "uncertain", started: Date.now() };
      }
      f.store.save();
      f.store.close();
      const reopened = new Store(f.store.dir);
      try {
        const factory = new Factory(
          reopened,
          new Git(f.repo),
          f.factory.agents,
          f.factory.delivery,
        );
        if (boundary === "active") {
          await assert.rejects(factory.resume(), /uncertain/i);
          assert.deepEqual(f.calls, ["planner"]);
          return;
        }
        await factory.resume();
        await factory.drive();
        if (boundary === "exhausted") {
          assert.equal(factory.state.phase, "completed", factory.state.error);
          assert.ok(f.calls.includes("worker"));
        } else {
          assert.equal(factory.state.phase, "completed", factory.state.error);
          assert.equal(
            f.calls.filter((role) => role === "challenger").length,
            boundary === "approved" ? 0 : 1,
          );
          assert.equal(factory.state.planning?.reviews.length, boundary === "revise" ? 2 : 1);
        }
      } finally {
        reopened.close();
      }
    });
  }
});

test("planning completion interruption and pause retain uncertain active operation", async (t) => {
  for (const role of ["challenger", "planner"] as const) {
    for (const mode of ["interruption", "pause"] as const) {
      await t.test(`${role} ${mode}`, async (t) => {
        const f = fixture(t);
        const run = f.factory.agents.run;
        let planners = 0;
        let captured = "";
        f.factory.agents.run = async (...args) => {
          if (args[0] === "challenger" && role === "planner") {
            f.calls.push("challenger");
            return { approved: false, findings: ["Revise"] };
          }
          const result = await run(...args);
          if (args[0] === "planner") {
            planners++;
          }
          if (args[0] === role && (role !== "planner" || planners === 2)) {
            if (mode === "pause") {
              f.factory.pause();
            }
          }
          return result;
        };
        const save = f.store.save.bind(f.store);
        f.store.save = () => {
          const s = f.store.state;
          if (
            !captured &&
            s?.active?.role === role &&
            s.executions.at(-1)?.role === role &&
            (role !== "planner" || planners === 2)
          ) {
            save();
            captured = readFileSync(join(f.store.dir, "state.json"), "utf8");
            if (mode === "interruption") {
              throw new Error("simulated interruption");
            }
            return;
          }
          save();
        };
        await f.factory.request("change app", "local");
        assert.ok(captured);
        const copy = join(f.root, "reopened");
        makeDirectory(copy);
        writeFileSync(join(copy, "state.json"), captured);
        const reopened = new Store(copy);
        try {
          assert.equal(reopened.state?.active?.role, role);
          const factory = new Factory(
            reopened,
            new Git(f.repo),
            f.factory.agents,
            f.factory.delivery,
          );
          const calls = f.calls.length;
          await assert.rejects(factory.resume(), /uncertain/i);
          assert.equal(f.calls.length, calls);
        } finally {
          reopened.close();
        }
      });
    }
  }
});
