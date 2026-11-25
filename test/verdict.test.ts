import assert from "node:assert/strict";
import { test } from "node:test";

import { verificationText } from "../src/delivery.ts";
import { validateRun, type Run } from "../src/state.ts";

const state = () => ({
  version: 2,
  id: "12345678-1234-1234-1234-123456789abc",
  request: "request",
  repo: "/repo",
  baseRevision: "base",
  phase: "planning",
  location: "worktree",
  worktree: "/work",
  planRevision: 1,
  plans: [],
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
  revision: "abc",
});

test("persisted verdict is revision-bound and rendered without legacy claims", () => {
  for (const status of ["failed", "incomplete", "verified"] as const) {
    const run = {
      ...state(),
      verificationVerdict: { status, revision: "abc", reason: "Evidence summary" },
    };
    validateRun(run);
    assert.match(verificationText(run), new RegExp(`Verification: ${status}\\. Evidence summary`));
    assert.doesNotMatch(
      verificationText(run),
      /reviews, documentation audit and completion triage passed/,
    );
    assert.throws(() =>
      validateRun({
        ...run,
        verificationVerdict: { ...run.verificationVerdict, revision: "other" },
      }),
    );
    assert.throws(() => verificationText({ ...run, revision: "other" }));
    assert.throws(() =>
      validateRun({ ...run, verificationVerdict: { ...run.verificationVerdict, reason: "" } }),
    );
  }
  assert.match(verificationText(state() as Run), /completion triage passed/);
});
