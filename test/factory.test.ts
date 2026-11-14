import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { Factory } from "../src/controller.ts";
import { Git } from "../src/git.ts";
import { Store } from "../src/state.ts";
import type { Run, Evidence } from "../src/state.ts";

type CommandContext = { ui: { notify(message: string): void } };
type CommandHandler = (args: string, ctx: CommandContext) => Promise<void>;
type Command = { description: string; handler: CommandHandler };

function present<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
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
        return {
          findings: [
            {
              id: "test-failure",
              blocking: true,
              confirmed: true,
              evidence: "Reproduced failed tests",
              reproduction: plan.verification[0],
            },
          ],
        };
      }
      if (role === "docs") {
        return { summary: "Docs current", changes: false };
      }
      return { summary: "Clean", findings: [] };
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

test("approval gate, full sequential lifecycle and final revision-bound evidence", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change app", "github");
  assert.equal(f.store.state?.phase, "awaiting_approval");
  assert.deepEqual(f.calls, ["planner"]);
  assert.equal(readFileSync(join(f.repo, "app.txt"), "utf8"), "old");
  assert.equal(f.store.state?.worktree, undefined);
  await f.factory.approve();
  await f.factory.drive();
  const s = present(f.store.state);
  assert.equal(s.phase, "completed");
  assert.equal(s.pr?.draft, true);
  assert.ok(s.evidence.length > 0);
  assert.ok(s.evidence.filter((e) => e.round === s.round).every((e) => e.revision === s.revision));
  assert.equal(git(f.repo, "show", "main:app.txt"), "old");
  assert.equal(s.worktree, f.repo);
  assert.equal(git(present(s.worktree), "status", "--porcelain"), "");
  assert.deepEqual(f.calls, [
    "planner",
    "worker",
    "tester",
    "quality",
    "security",
    "ponytail",
    "docs",
    "tester",
    "quality",
    "security",
    "ponytail",
  ]);
});

test("failures trigger two repairs, then block", async (t) => {
  const f = fixture(t, 99);
  await f.factory.plan("change", "github");
  await f.factory.approve();
  await f.factory.drive();
  assert.equal(f.repairs(), 2);
  assert.equal(f.store.state?.phase, "blocked");
  assert.match(present(present(f.store.state).error), /repair/i);
});

test("one failed test repairs and revalidates", async (t) => {
  const f = fixture(t, 1);
  await f.factory.plan("change", "github");
  await f.factory.approve();
  await f.factory.drive();
  assert.equal(f.repairs(), 1);
  assert.equal(f.store.state?.phase, "completed");
});

test("reject, lock and interrupted execution preserve artifacts", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "github");
  assert.throws(() => new Store(f.store.dir), /writer/i);
  f.factory.reject();
  await assert.rejects(f.factory.approve(), /plan/i);
  await f.factory.plan("revised", "github");
  await f.factory.approve();
  present(f.store.state).active = { role: "worker", requestId: "uncertain", started: Date.now() };
  f.store.save();
  f.store.close();
  const recovered = new Store(f.store.dir);
  t.after(() => {
    if (existsSync(recovered.dir)) {
      recovered.close();
    }
  });
  assert.equal(recovered.state?.phase, "blocked");
  assert.ok(recovered.state?.active);
  const factory = new Factory(recovered, new Git(f.repo), f.factory.agents, f.factory.delivery);
  await assert.rejects(factory.resume(), /uncertain/i);
  assert.ok(existsSync(present(present(recovered.state).worktree)));
});

test("scope escape blocks delivery and revokes approval", async (t) => {
  const f = fixture(t);
  f.factory.agents.run = async (role: string, task: string, cwd: string) => {
    if (role === "planner") {
      return f.plan;
    }
    writeFileSync(join(cwd, "unapproved.txt"), "escape");
    return { summary: "done", scopeChange: "" };
  };
  await f.factory.plan("change", "github");
  await f.factory.approve();
  await f.factory.drive();
  assert.equal(f.store.state?.phase, "blocked");
  assert.equal(f.store.state?.approvedRevision, undefined);
  assert.ok(existsSync(join(present(present(f.store.state).worktree), "unapproved.txt")));
});

test("pause and resume preserve the approval gate", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "github");
  await assert.rejects(f.factory.drive(), /approved/);
  await f.factory.approve();
  f.factory.pause();
  await assert.rejects(f.factory.drive(), /runnable/);
  await f.factory.resume();
  await f.factory.drive();
  assert.equal(present(f.store.state).phase, "completed");
});

test("approved command failure blocks delivery even if tester claims success", async (t) => {
  const f = fixture(t);
  present(f.plan.verification[0]).args = ["-e", "process.exit(1)"];
  await f.factory.plan("change", "github");
  await f.factory.approve();
  await f.factory.drive();
  assert.equal(present(f.store.state).phase, "blocked");
  assert.equal(present(f.store.state).pr, undefined);
  assert.equal(f.repairs(), 2);
});

test("documentation mutation is reverified at its new revision", async (t) => {
  const f = fixture(t);
  f.plan.files.push("docs.txt");
  const run = f.factory.agents.run.bind(f.factory.agents);
  let docs = false;
  f.factory.agents.run = async (role, task, cwd, identity, signal) => {
    if (role === "docs") {
      docs = true;
      return { summary: "Update docs", changes: true };
    }
    if (role === "worker" && docs) {
      writeFileSync(join(cwd, "docs.txt"), "new docs");
      return { summary: "docs", scopeChange: "" };
    }
    return run(role, task, cwd, identity, signal);
  };
  await f.factory.plan("change", "github");
  await f.factory.approve();
  await f.factory.drive();
  const s = present(f.store.state);
  assert.equal(s.phase, "completed");
  assert.notEqual(present(s.evidence.find((e) => e.role === "docs")).revision, s.revision);
  assert.ok(s.evidence.some((e) => e.role === "tester" && e.revision === s.revision));
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
  await f.factory.approve();
  await f.factory.drive();
  assert.equal(present(f.store.state).phase, "blocked");
  assert.equal(present(f.store.state).approvedRevision, undefined);
  assert.match(present(present(f.store.state).error), /HEAD/);
  assert.equal(present(f.store.state).pr, undefined);
});

test("delivery uncertainty is preserved and cannot be resumed", async (t) => {
  const f = fixture(t);
  f.factory.delivery.deliver = async () => {
    throw new Error("uncertain push");
  };
  await f.factory.plan("change", "github");
  await f.factory.approve();
  await f.factory.drive();
  assert.equal(present(f.store.state).phase, "blocked");
  assert.ok(present(f.store.state).deliveryIntent);
  await assert.rejects(f.factory.resume(), /uncertain/i);
});

test("recovery requires a new approval", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "github");
  await f.factory.approve();
  present(f.store.state).active = { role: "worker", requestId: "stopped", started: Date.now() };
  f.store.save();
  await f.factory.replanAfterInterruption();
  assert.equal(present(f.store.state).phase, "awaiting_approval");
  assert.equal(present(f.store.state).approvedRevision, undefined);
  await assert.rejects(f.factory.drive(), /approved/);
  await f.factory.approve();
  await f.factory.drive();
  assert.equal(present(f.store.state).phase, "completed");
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
  git(f.repo, "config", `url.${bare}.insteadOf`, "https://github.com/example/repo.git");
  await f.factory.approve();
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
  await f.factory.approve();
  const s = present(f.store.state);
  s.active = { role: "worker", requestId: "uncertain", started: Date.now() };
  s.cancelled = true;
  s.phase = "blocked";
  f.store.save();
  await assert.rejects(f.factory.plan("another", "github"), /uncertain/);
  await assert.rejects(f.factory.replanAfterInterruption(), /uncertain/i);
  assert.equal(s.active.requestId, "uncertain");
});

test("recovery preserves repair count and rejects unrelated blocks", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "github");
  await f.factory.approve();
  const s = present(f.store.state);
  s.phase = "blocked";
  s.repairs = 2;
  f.store.save();
  await assert.rejects(f.factory.replanAfterInterruption(), /uncertain/i);
  s.active = { role: "worker", requestId: "uncertain", started: Date.now() };
  f.store.save();
  await f.factory.replanAfterInterruption();
  assert.equal(s.repairs, 2);
});

test("inspected recovery replans an exhausted quality gate without bypassing approval or verification", async (t) => {
  const f = fixture(t, 99);
  await f.factory.plan("change", "github");
  await f.factory.approve();
  await f.factory.drive();
  const s = present(f.store.state);
  assert.equal(s.phase, "blocked");
  assert.equal(s.step, "verify");
  assert.equal(s.paused, false);
  assert.equal(s.active, undefined);
  const evidence = structuredClone(s.evidence);
  const findings = structuredClone(s.findings);
  const base = s.baseRevision;
  const revision = s.revision;
  const contents = readFileSync(join(f.repo, "app.txt"), "utf8");
  await assert.rejects(f.factory.resume(), /quality gate/i);
  await f.factory.replanAfterInterruption();
  assert.equal(s.phase, "awaiting_approval");
  assert.equal(s.approvedRevision, undefined);
  assert.equal(s.planRevision, 2);
  assert.equal(s.repairs, 2);
  assert.deepEqual(s.evidence, evidence);
  assert.deepEqual(s.findings, findings);
  assert.equal(s.baseRevision, base);
  assert.equal(s.revision, revision);
  assert.equal(readFileSync(join(f.repo, "app.txt"), "utf8"), contents);
  await assert.rejects(f.factory.resume(), /approval/i);
  await assert.rejects(f.factory.drive(), /approved/i);
  await f.factory.approve();
  await f.factory.drive();
  assert.equal(s.phase, "blocked");
  assert.equal(s.pr, undefined);
  assert.ok(s.evidence.length > evidence.length);
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
  await f.factory.approve();
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

test("approval interruption during preflight prevents worktree creation", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "github");
  f.factory.agents.preflight = async () => {
    f.factory.cancel();
  };
  await assert.rejects(f.factory.approve(), /stop/i);
  assert.equal(present(f.store.state).cancelled, true);
  assert.equal(present(f.store.state).worktree, undefined);
});

test("invalid persisted evidence is rejected without rewriting the state", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "github");
  await f.factory.approve();
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
  await f.factory.approve();
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
  await f.factory.approve();
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

test("command dispatch gates planning, concurrent approval and shutdown", async (t) => {
  const { registerFactoryCommands } = await import("../src/commands.ts");
  const f = fixture(t);
  let handler!: CommandHandler, shutdown!: () => Promise<void>;
  const notices: string[] = [];
  const pi = {
    registerCommand(_name: string, command: Command) {
      handler = command.handler;
    },

    on(_event: string, cb: () => Promise<void>) {
      shutdown = cb;
    },
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
    async () => f.factory,
    () => f.store.close(),
  );
  await handler("request change app", ctx);
  assert.deepEqual(f.calls, ["planner"]);
  assert.equal(present(f.store.state).phase, "awaiting_approval");
  let release!: () => void;
  const waiting = new Promise<void>((r) => {
    release = r;
  });
  f.factory.agents.preflight = async () => waiting;
  const first = handler("approve", ctx);
  await handler("approve", ctx);
  assert.ok(notices.some((n) => /already in progress/.test(n)));
  const stopping = shutdown();
  await Promise.resolve();
  assert.throws(() => new Store(f.store.dir), /writer/);
  release();
  await first;
  await stopping;
  const reopened = new Store(f.store.dir);
  reopened.close();
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
    assert.equal(present(f.store.state).approvedRevision, undefined);
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
  const first = handler("request first", ctx);
  await handler("request second", ctx);
  const status = handler("status", ctx);
  release();
  await Promise.all([first, status]);
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
      s.approvedRevision = undefined;
    },
  ]) {
    const f = fixture(t);
    await f.factory.plan("change", "github");
    await f.factory.approve();
    await f.factory.drive();
    assert.ok(f.store.state);
    corrupt(f.store.state);
    f.store.save();
    f.store.close();
    assert.throws(() => new Store(f.store.dir), /Invalid factory state/);
  }
  // oxlint-enable no-await-in-loop
});

test("pause or cancellation during recovery preflight stops recovery", async (t) => {
  // oxlint-disable no-await-in-loop -- Each preflight-stop race needs ordered setup, release, and cleanup.
  for (const action of ["pause", "cancel"] as const) {
    const f = fixture(t);
    await f.factory.plan("change", "local");
    await f.factory.approve();
    f.factory.pause();
    let started!: () => void,
      release!: () => void,
      plannerCalled = false;
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
    f.factory.agents.run = async () => {
      plannerCalled = true;
      return f.plan;
    };
    const recovery = f.factory.replanAfterInterruption();
    await waiting;
    f.factory[action]();
    release();
    await assert.rejects(recovery, /stop/i);
    assert.equal(plannerCalled, false);
    assert.equal(f.factory.state.paused, true);
    assert.equal(f.factory.state.cancelled, action === "cancel");
    assert.equal(f.factory.state.phase, "blocked");
  }
  // oxlint-enable no-await-in-loop
});

test("cancellation during recovery planning persists across restart", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "github");
  await f.factory.approve();
  present(f.store.state).active = { role: "worker", requestId: "stopped", started: Date.now() };
  f.store.save();
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
  const recovery = f.factory.replanAfterInterruption();
  await waiting;
  f.factory.cancel();
  release();
  await assert.rejects(recovery, /stop/i);
  f.store.close();
  const reopened = new Store(f.store.dir);
  try {
    assert.equal(present(reopened.state).cancelled, true);
    assert.equal(present(reopened.state).phase, "blocked");
    await assert.rejects(
      new Factory(reopened, new Git(f.repo), f.factory.agents, f.factory.delivery).approve(),
      /plan/i,
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
      };
    }
    return run(...args);
  };
  await f.factory.plan("change", "github");
  await f.factory.approve();
  await f.factory.drive();
  assert.equal(present(f.store.state).phase, "completed", present(f.store.state).error);
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
  await f.factory.approve();
  const run = f.factory.agents.run.bind(f.factory.agents);
  f.factory.agents.run = async (...args) => {
    const result = await run(...args);
    if (args[0] === "ponytail" && present(f.store.state).documented) {
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

test("local delivery persists selection and completes without GitHub or pre-approval mutations", async (t) => {
  const f = fixture(t);
  f.factory.delivery.preflight = async () => {
    throw new Error("GitHub must not run");
  };
  f.factory.delivery.deliver = async () => {
    throw new Error("GitHub delivery must not run");
  };
  await f.factory.plan("change app", "local");
  assert.equal(present(f.store.state).delivery, "local");
  assert.equal(present(f.store.state).target, undefined);
  assert.equal(present(f.store.state).worktree, undefined);
  assert.deepEqual(f.calls, ["planner"]);
  f.store.close();
  const reopened = new Store(f.store.dir);
  try {
    const factory = new Factory(reopened, new Git(f.repo), f.factory.agents, f.factory.delivery);
    assert.equal(factory.state.delivery, "local");
    await assert.rejects(factory.drive(), /approved/);
    await factory.approve();
    await factory.drive();
    const s = factory.state;
    assert.equal(s.phase, "completed", s.error);
    assert.equal(s.pr, undefined);
    assert.deepEqual(s.localReceipt, {
      revision: s.revision,
      branch: s.branch,
      worktree: s.worktree,
    });
    assert.equal(git(present(s.worktree), "rev-parse", "HEAD"), s.revision);
    assert.match(factory.report(), /no push or PR/);
  } finally {
    reopened.close();
  }
});

test("local persisted receipt fails closed when altered but permits later edits", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "local");
  await f.factory.approve();
  await f.factory.drive();
  const path = join(f.store.dir, "state.json");
  const original = readFileSync(path, "utf8");
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
    writeFileSync(path, JSON.stringify(s));
    const corrupted = readFileSync(path, "utf8");
    assert.throws(() => new Store(f.store.dir), /invalid/i);
    assert.equal(readFileSync(path, "utf8"), corrupted);
  }
  writeFileSync(path, original);
  writeFileSync(join(present(present(f.store.state).worktree), "app.txt"), "dirty");
  const reopened = new Store(f.store.dir);
  try {
    const factory = new Factory(reopened, new Git(f.repo), f.factory.agents, f.factory.delivery);
    assert.match(factory.report(), /Local receipt/);
    await assert.rejects(factory.plan("next", "local"), /clean/);
    git(f.repo, "add", "app.txt");
    git(f.repo, "commit", "-m", "user edit");
    git(f.repo, "switch", "main");
    assert.match(factory.report(), /Local receipt/);
    await factory.plan("next", "local");
    assert.equal(readFileSync(join(f.repo, "app.txt"), "utf8"), "old");
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
  await f.factory.approve();
  await f.factory.drive();
  assert.equal(f.factory.state.phase, "completed", f.factory.state.error);
  assert.ok(f.factory.state.localReceipt);
  assert.equal(f.factory.state.pr, undefined);
});

test("command request forms default to local and accept explicit GitHub", async (t) => {
  const { registerFactoryCommands } = await import("../src/commands.ts");
  // oxlint-disable no-await-in-loop -- Keep independent Git-backed command fixtures serial for deterministic cleanup.
  for (const [input, mode] of [
    ["Build app", "local"],
    ["request Build app", "local"],
    ["--delivery github Build app", "github"],
    ["request --delivery github Build app", "github"],
  ] as const) {
    const f = fixture(t);
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
    await handler(input, {
      ui: {
        notify(message: string) {
          notices.push(message);
        },
      },
    });
    assert.equal(f.factory.state.request, "Build app");
    assert.equal(f.factory.state.delivery, mode);
    assert.ok(notices.some((notice) => notice.includes(`Delivery: ${mode}`)));
  }
  // oxlint-enable no-await-in-loop
});

test("local final test failure exhausts two repairs without delivery", async (t) => {
  const f = fixture(t, 99);
  await f.factory.plan("change", "local");
  await f.factory.approve();
  await f.factory.drive();
  assert.equal(f.repairs(), 2);
  assert.equal(present(f.store.state).phase, "blocked");
  assert.equal(present(f.store.state).localReceipt, undefined);
});

test("request delivery selector preserves request words and rejects missing mode or request", async (t) => {
  const { registerFactoryCommands } = await import("../src/commands.ts");
  const f = fixture(t);
  let handler!: CommandHandler;
  const notices: string[] = [];
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
    async () => f.factory,
    () => {},
  );
  await handler("request --delivery", ctx);
  assert.equal(f.store.state, undefined);
  await handler("request --delivery local", ctx);
  assert.equal(f.store.state, undefined);
  // oxlint-disable no-await-in-loop -- Check each invalid form leaves the shared handler state-free before the next.
  for (const input of [
    "--delivery",
    "--delivery local",
    "--delivery bogus change",
    "request change --delivery local",
    "request --delivery local change --delivery github",
    "change --delivery local",
  ]) {
    await handler(input, ctx);
    assert.equal(f.store.state, undefined, input);
  }
  // oxlint-enable no-await-in-loop
  await handler("--delivery local keep --option value", ctx);
  const state = f.factory.state;
  assert.equal(state.request, "keep --option value");
  assert.equal(state.delivery, "local");
  assert.ok(notices.some((n) => /Delivery: local/.test(n)));
});

test("local confirmed review blocker exhausts repairs", async (t) => {
  const f = fixture(t);
  const run = f.factory.agents.run.bind(f.factory.agents);
  f.factory.agents.run = async (role, task, cwd, identity, signal) => {
    if (role === "quality") {
      return {
        summary: "Defect",
        findings: [{ id: "defect", blocking: true, evidence: "app.txt" }],
      };
    }
    if (role === "triage") {
      return {
        findings: [{ id: "quality:defect", blocking: true, confirmed: true, evidence: "app.txt" }],
      };
    }
    return run(role, task, cwd, identity, signal);
  };
  await f.factory.plan("change", "local");
  await f.factory.approve();
  await f.factory.drive();
  assert.equal(f.repairs(), 2);
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
  await f.factory.approve();
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

test("approved delivery mode cannot be switched in memory or on restart", async (t) => {
  // oxlint-disable no-await-in-loop -- Each mode-switch scenario mutates and reloads its own Git-backed run.
  for (const mode of ["local", "github"] as const) {
    const f = fixture(t);
    await f.factory.plan("change", mode);
    await f.factory.approve();
    const s = present(f.store.state);
    assert.equal(s.approvedDelivery, mode);
    const target = {
      repo: "example/repo",
      base: "main",
      remote: "https://github.com/example/repo.git",
    };
    s.delivery = mode === "local" ? "github" : "local";
    s.target = mode === "local" ? target : undefined;
    await assert.rejects(f.factory.drive(), /approved/);
    await assert.rejects(f.factory.resume(), /approval/i);
    f.store.save();
    const path = join(f.store.dir, "state.json");
    const corrupted = readFileSync(path, "utf8");
    f.store.close();
    assert.throws(() => new Store(f.store.dir), /invalid/i);
    assert.equal(readFileSync(path, "utf8"), corrupted);
  }
  // oxlint-enable no-await-in-loop
});

test("approved legacy GitHub state without either mode remains runnable", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "github");
  await f.factory.approve();
  f.factory.pause();
  const path = join(f.store.dir, "state.json");
  f.store.close();
  const s = JSON.parse(readFileSync(path, "utf8"));
  delete s.delivery;
  delete s.approvedDelivery;
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
  await f.factory.approve();
  await f.factory.drive();
  assert.equal(f.factory.state.phase, "blocked");
  assert.equal(delivered, false);
  assert.equal(f.factory.state.localReceipt, undefined);
  assert.equal(f.factory.state.pr, undefined);
});

test("current checkout is used after approval and ignored configuration survives", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repo, ".git", "info", "exclude"), ".pi/\nnode_modules/\n");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(f.repo, ".pi"));
  mkdirSync(join(f.repo, "node_modules"));
  writeFileSync(join(f.repo, ".pi", "marker"), "config");
  writeFileSync(join(f.repo, "node_modules", "marker"), "deps");
  const run = f.factory.agents.run;
  f.factory.agents.run = async (...args) => {
    assert.equal(args[2], f.repo);
    return run(...args);
  };
  await f.factory.plan("change", "local");
  assert.equal(git(f.repo, "branch", "--show-current"), "main");
  await f.factory.approve();
  assert.equal(git(f.repo, "branch", "--show-current"), f.factory.state.branch);
  await f.factory.drive();
  assert.equal(f.factory.state.phase, "completed", f.factory.state.error);
  assert.equal(readFileSync(join(f.repo, ".pi", "marker"), "utf8"), "config");
  assert.equal(readFileSync(join(f.repo, "node_modules", "marker"), "utf8"), "deps");
  assert.equal(git(f.repo, "show", "main:app.txt"), "old");
});

test("paused checkout edits and branch switches block resume without discarding data", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "local");
  await f.factory.approve();
  f.factory.pause();
  writeFileSync(join(f.repo, "app.txt"), "manual");
  await assert.rejects(f.factory.resume(), /working tree/);
  assert.equal(readFileSync(join(f.repo, "app.txt"), "utf8"), "manual");
  git(f.repo, "add", "app.txt");
  git(f.repo, "commit", "-m", "manual");
  git(f.repo, "switch", "main");
  await assert.rejects(f.factory.resume(), /branch changed/);
  assert.equal(git(f.repo, "show", f.factory.state.branch + ":app.txt"), "manual");
});

test("paused checkout without a snapshot requires inspected recovery", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "local");
  await f.factory.approve();
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
  await f.factory.approve();
  f.factory.pause();
  delete f.factory.state.location;
  await assert.rejects(f.factory.resume(), /legacy execution location/i);
});

test("inspected paused edits require renewed approval and fresh verification", async (t) => {
  const f = fixture(t);
  await f.factory.plan("change", "local");
  await f.factory.approve();
  f.factory.pause();
  writeFileSync(join(f.repo, "app.txt"), "manual");
  await assert.rejects(f.factory.resume(), /working tree/);
  await f.factory.replanAfterInterruption();
  assert.equal(f.factory.state.phase, "awaiting_approval");
  assert.equal(readFileSync(join(f.repo, "app.txt"), "utf8"), "manual");
  await f.factory.approve();
  await f.factory.drive();
  assert.equal(f.factory.state.phase, "completed", f.factory.state.error);
  assert.ok(
    f.factory.state.evidence.some((e) => e.role === "tester" && e.round === f.factory.state.round),
  );
});

test("approval branch creation interruption remains loadable and uncertain before and after switch", async (t) => {
  // oxlint-disable no-await-in-loop -- Reconcile each interrupted branch-create repository before starting the next.
  for (const after of [false, true]) {
    const f = fixture(t);
    await f.factory.plan("change", "local");
    const create = f.factory.git.create.bind(f.factory.git);
    f.factory.git.create = (s) => {
      if (after) {
        create(s);
      }
      throw new Error("interrupted");
    };
    await assert.rejects(f.factory.approve(), /interrupted/);
    assert.equal(f.factory.state.active?.role, "branch-create");
    f.store.close();
    const reopened = new Store(f.store.dir);
    try {
      assert.equal(present(reopened.state).phase, "blocked");
      assert.equal(present(reopened.state).active?.role, "branch-create");
      await assert.rejects(
        new Factory(reopened, new Git(f.repo), f.factory.agents, f.factory.delivery).resume(),
        /uncertain/i,
      );
      assert.equal(
        git(f.repo, "branch", "--show-current"),
        after ? present(reopened.state).branch : "main",
      );
    } finally {
      reopened.close();
    }
  }
  // oxlint-enable no-await-in-loop
});

test("recovery checkpoint failures before and after commit retain durable intent and files", async (t) => {
  // oxlint-disable no-await-in-loop -- Reconcile each interrupted checkpoint's Git and store state before the next case.
  for (const after of [false, true]) {
    const f = fixture(t);
    await f.factory.plan("change", "local");
    await f.factory.approve();
    f.factory.pause();
    writeFileSync(join(f.repo, "app.txt"), "inspected");
    await f.factory.replanAfterInterruption();
    const checkpoint = f.factory.git.checkpoint.bind(f.factory.git);
    f.factory.git.checkpoint = (s, p) => {
      if (after) {
        checkpoint(s, p);
      } else {
        git(f.repo, "add", "app.txt");
      }
      throw new Error("commit interrupted");
    };
    await assert.rejects(f.factory.approve(), /interrupted/);
    f.store.close();
    const reopened = new Store(f.store.dir);
    try {
      assert.equal(present(reopened.state).active?.role, "checkpoint");
      assert.equal(present(reopened.state).phase, "blocked");
      assert.equal(readFileSync(join(f.repo, "app.txt"), "utf8"), "inspected");
      assert.equal(git(f.repo, "branch", "--show-current"), present(reopened.state).branch);
      if (!after) {
        assert.equal(git(f.repo, "diff", "--cached", "--name-only"), "app.txt");
      }
      await assert.rejects(
        new Factory(reopened, new Git(f.repo), f.factory.agents, f.factory.delivery).resume(),
        /uncertain/i,
      );
    } finally {
      reopened.close();
    }
  }
  // oxlint-enable no-await-in-loop
});

test("paused ignored configuration and dependencies are bound to resume and recovery approval", async (t) => {
  const f = fixture(t);
  const { mkdirSync } = await import("node:fs");
  writeFileSync(join(f.repo, ".git", "info", "exclude"), ".pi/\nnode_modules/\n");
  mkdirSync(join(f.repo, ".pi"));
  mkdirSync(join(f.repo, "node_modules"));
  writeFileSync(join(f.repo, ".pi", "config"), "one");
  writeFileSync(join(f.repo, "node_modules", "dep"), "one");
  await f.factory.plan("change", "local");
  await f.factory.approve();
  f.factory.pause();
  await f.factory.resume();
  f.factory.pause();
  writeFileSync(join(f.repo, ".pi", "config"), "two");
  await assert.rejects(f.factory.resume(), /inspect and replan/);
  await f.factory.replanAfterInterruption();
  writeFileSync(join(f.repo, "node_modules", "dep"), "two");
  await assert.rejects(f.factory.approve(), /changed since planning/);
  assert.equal(readFileSync(join(f.repo, ".pi", "config"), "utf8"), "two");
  assert.equal(readFileSync(join(f.repo, "node_modules", "dep"), "utf8"), "two");
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
  await f.factory.approve();
  await f.factory.drive();
  assert.equal(f.factory.state.paused, true);
  await f.factory.resume();
  assert.equal(f.factory.state.paused, false);
});

test("delivery pause recovery persists loadable replanning states and requires fresh approval", async (t) => {
  // oxlint-disable no-await-in-loop -- Each outcome walks a full durable run/restart path; serialize Git and store recovery.
  for (const outcome of ["throw", "cancel", "success"] as const) {
    const f = fixture(t);
    await f.factory.plan("change", "local");
    await f.factory.approve();
    f.factory.changed = (s) => {
      if (s.step === "deliver" && !s.paused) {
        f.factory.pause();
      }
    };
    await f.factory.drive();
    const s = f.factory.state;
    assert.equal(s.step, "deliver");
    assert.equal(s.paused, true);
    const previous = {
      branch: s.branch,
      revision: s.revision,
      repairs: s.repairs,
      round: s.round,
      evidence: s.evidence.length,
      planRevision: s.planRevision,
    };
    const snapshots: string[] = [];
    f.factory.changed = (state) => {
      if (state.phase === "planning") {
        snapshots.push(readFileSync(join(f.store.dir, "state.json"), "utf8"));
      }
    };
    const run = f.factory.agents.run.bind(f.factory.agents);
    f.factory.agents.run = async (...args) => {
      if (args[0] !== "planner") {
        return run(...args);
      }
      if (outcome === "throw") {
        throw new Error("planner failed");
      }
      if (outcome === "cancel") {
        f.factory.cancel();
      }
      return f.plan;
    };
    if (outcome === "success") {
      await f.factory.replanAfterInterruption();
    } else {
      await assert.rejects(
        f.factory.replanAfterInterruption(),
        outcome === "throw" ? /planner failed/ : /stop/i,
      );
    }
    assert.ok(snapshots.length >= 2);
    for (const [i, snapshot] of snapshots.entries()) {
      const dir = join(f.root, `snapshot-${i}`);
      const copy = new Store(dir);
      copy.close();
      writeFileSync(join(dir, "state.json"), snapshot);
      const reopened = new Store(dir);
      try {
        assert.equal(present(reopened.state).phase, "blocked");
        assert.equal(present(reopened.state).step, "implement");
        assert.equal(present(reopened.state).approvedRevision, undefined);
        assert.equal(present(reopened.state).approvedDelivery, undefined);
        assert.equal(present(reopened.state).branch, previous.branch);
        assert.equal(present(reopened.state).revision, previous.revision);
        assert.equal(present(reopened.state).repairs, previous.repairs);
        assert.equal(present(reopened.state).evidence.length, previous.evidence);
      } finally {
        reopened.close();
      }
    }
    f.store.close();
    const reopened = new Store(f.store.dir);
    try {
      const factory = new Factory(reopened, new Git(f.repo), f.factory.agents, f.factory.delivery);
      if (outcome !== "success") {
        assert.equal(factory.state.phase, "blocked");
        assert.equal(factory.state.approvedRevision, undefined);
        await assert.rejects(factory.approve(), /plan/i);
      } else {
        assert.equal(factory.state.phase, "awaiting_approval");
        assert.equal(factory.state.planRevision, previous.planRevision + 1);
        await assert.rejects(factory.drive(), /approved/);
        await factory.approve();
        await factory.drive();
        assert.equal(factory.state.phase, "completed", factory.state.error);
        assert.ok(factory.state.round > previous.round);
        assert.ok(
          factory.state.evidence.some(
            (e) => e.role === "tester" && e.round === factory.state.round,
          ),
        );
      }
    } finally {
      reopened.close();
    }
  }
  // oxlint-enable no-await-in-loop
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

test("inspected initial planner interruption replans without replacing artifacts", async (t) => {
  const f = fixture(t);
  const run = f.factory.agents.run;
  f.factory.agents.run = async () => {
    throw new Error("planner interrupted");
  };
  await assert.rejects(f.factory.plan("change", "local"), /interrupted/);
  f.factory.cancel();
  f.factory.agents.run = run;
  const s = f.factory.state;
  await assert.rejects(f.factory.plan("another"), /uncertain/);
  writeFileSync(join(f.repo, "app.txt"), "preserve");
  await assert.rejects(f.factory.replanAfterInterruption(), /changed since planning/);
  assert.equal(s.active?.role, "planner");
  assert.equal(readFileSync(join(f.repo, "app.txt"), "utf8"), "preserve");
  writeFileSync(join(f.repo, "app.txt"), "old");
  await f.factory.replanAfterInterruption();
  assert.equal(s.phase, "awaiting_approval");
  assert.equal(s.planRevision, 1);
  assert.equal(s.cancelled, false);
  assert.equal(
    JSON.parse(readFileSync(join(f.store.dir, s.id + ".json"), "utf8")).active.role,
    "planner",
  );
  f.store.close();
  const reopened = new Store(f.store.dir);
  try {
    assert.equal(reopened.state?.phase, "awaiting_approval");
  } finally {
    reopened.close();
  }
});

test("initial planner validation and checkout failures remain recoverable on retry", async (t) => {
  // oxlint-disable no-await-in-loop -- Each case verifies sequential durable recovery attempts.
  for (const failure of ["invalid plan", "changed checkout"] as const) {
    const f = fixture(t);
    const run = f.factory.agents.run;
    f.factory.agents.run = async () => {
      if (failure === "invalid plan") {
        return { ...f.plan, tasks: [] };
      }
      writeFileSync(join(f.repo, "app.txt"), "planner change");
      return f.plan;
    };
    await assert.rejects(f.factory.plan("change", "local"));
    assert.equal(f.factory.state.active, undefined);
    if (failure === "changed checkout") {
      await assert.rejects(f.factory.replanAfterInterruption(), /changed since planning/);
      writeFileSync(join(f.repo, "app.txt"), "old");
    }
    await assert.rejects(f.factory.replanAfterInterruption());
    assert.equal(f.factory.state.phase, "blocked");
    assert.equal(f.factory.state.active, undefined);
    if (failure === "changed checkout") {
      writeFileSync(join(f.repo, "app.txt"), "old");
    }
    f.store.close();
    const reopened = new Store(f.store.dir);
    try {
      f.factory.agents.run = run;
      const factory = new Factory(reopened, new Git(f.repo), f.factory.agents, f.factory.delivery);
      await factory.replanAfterInterruption();
      assert.equal(factory.state.phase, "awaiting_approval");
      assert.equal(factory.state.planRevision, 1);
      assert.equal(factory.state.plans.length, 1);
    } finally {
      reopened.close();
    }
  }
  // oxlint-enable no-await-in-loop
});
