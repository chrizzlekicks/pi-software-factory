import assert from "node:assert/strict";
import { test } from "node:test";

import { validateRun } from "../src/state.ts";

const plan = {
  summary: "Plan",
  tasks: ["Task"],
  files: ["a"],
  risks: [],
  dependencies: [],
  verification: [{ command: "node", args: [], purpose: "Check" }],
};
const state = () => ({
  version: 2,
  id: "12345678-1234-1234-1234-123456789abc",
  request: "request",
  repo: "/repo",
  baseRevision: "abc",
  phase: "planning",
  location: "worktree",
  worktree: "/work",
  planRevision: 1,
  plans: [plan],
  branch: "factory/12345678-1234-1234-1234-123456789abc",
  delivery: "local",
  step: "implement",
  task: 0,
  repairs: 0,
  round: 0,
  documented: false,
  paused: false,
  cancelled: false,
  executions: [],
  evidence: [],
  findings: [],
  updated: 1,
});

test("planning progress validates approval and exhaustion boundaries", () => {
  const rejected = { planRevision: 1, approved: false, findings: ["risk"] };
  assert.throws(() =>
    validateRun({
      ...state(),
      planning: { next: "revise", reviews: [{ ...rejected, findings: [] }], unresolved: [] },
    }),
  );
  assert.doesNotThrow(() =>
    validateRun({ ...state(), planning: { next: "review", reviews: [], unresolved: [] } }),
  );
  assert.doesNotThrow(() =>
    validateRun({ ...state(), planning: { next: "revise", reviews: [rejected], unresolved: [] } }),
  );
  assert.throws(() =>
    validateRun({
      ...state(),
      planning: { next: "approved", reviews: [rejected], unresolved: [] },
    }),
  );
  assert.throws(() =>
    validateRun({
      ...state(),
      planning: { next: "blocked", reviews: [rejected], unresolved: ["risk"] },
    }),
  );
  const reviews = [rejected, { ...rejected, planRevision: 2 }, { ...rejected, planRevision: 3 }];
  const exhausted = { ...state(), planRevision: 3, plans: [plan, plan, plan] };
  assert.doesNotThrow(() =>
    validateRun({ ...exhausted, planning: { next: "exhausted", reviews, unresolved: ["risk"] } }),
  );
  assert.throws(() =>
    validateRun({ ...exhausted, planning: { next: "exhausted", reviews, unresolved: [] } }),
  );
});
