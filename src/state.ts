export const MAX_REVIEW_FINDINGS = 64;
export const MAX_TRIAGE_FINDINGS = 3 * MAX_REVIEW_FINDINGS + 2;

import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  renameSync,
  fsyncSync,
  unlinkSync,
  existsSync,
  linkSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { validatePlan, validateCommand } from "./git.ts";

export type Phase =
  | "planning"
  | "implementing"
  | "testing"
  | "reviewing"
  | "repairing"
  | "documenting"
  | "delivering"
  | "completed"
  | "blocked"
  | "failed";

export type Command = { command: string; args: string[]; purpose: string };

export type Plan = {
  summary: string;
  tasks: string[];
  files: string[];
  risks: string[];
  dependencies: string[];
  verification: Command[];
};

export type Finding = {
  id: string;
  blocking: boolean;
  confirmed?: boolean;
  evidence: string;
  reproduction?: Command;
};

export type Evidence = {
  role: string;
  revision: string;
  round: number;
  result: unknown;
  at: number;
};

export type Run = {
  version: 1 | 2;
  id: string;
  request: string;
  repo: string;
  baseRevision: string;
  phase: Phase;
  location?: "checkout" | "worktree";
  candidateSnapshot?: string | undefined;
  reviewPaths?: string[] | undefined;
  noChanges?: boolean | undefined;
  pauseSnapshot?: string | undefined;
  planRevision: number;
  plans: Plan[];
  branch: string;
  worktree?: string;
  delivery?: "github" | "local";
  target?: { repo: string; base: string; remote: string } | undefined;
  step: string;
  task: number;
  repairs: number;
  round: number;
  documented: boolean;
  paused: boolean;
  cancelled: boolean;
  revision?: string;
  error?: string | undefined;
  active?: { role: string; requestId: string; started: number } | undefined;
  executions: Evidence[];
  evidence: Evidence[];
  findings: Finding[];
  pr?: { url: string; head: string; draft: boolean };
  localReceipt?: { revision: string; branch: string; worktree: string };
  deliveryIntent?: string | undefined;
  updated: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function text(x: unknown): x is string {
  return typeof x === "string" && x.length > 0;
}

function integer(x: unknown): x is number {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
}

function invalidFinalFindings(): never {
  throw new Error("Invalid final findings");
}

function invalidState(): never {
  throw new Error("Invalid factory state");
}

export function validateFinalFindings(s: Run) {
  const fail: () => never = invalidFinalFindings;
  const current = s.evidence.filter((e) => e.round === s.round && e.revision === s.revision);
  const originals: Record<string, unknown>[] = [];
  for (const role of ["quality", "security", "ponytail"]) {
    const reviews = current.filter((e) => e.role === role);
    const review = reviews[0]?.result;
    const coverage = isRecord(review) ? review.coverage : undefined;
    if (
      reviews.length !== 1 ||
      !isRecord(review) ||
      !Array.isArray(review.findings) ||
      review.findings.length > MAX_REVIEW_FINDINGS ||
      !Array.isArray(coverage) ||
      !s.reviewPaths ||
      coverage.length !== s.reviewPaths.length ||
      new Set(coverage).size !== s.reviewPaths.length ||
      s.reviewPaths.some((path) => !coverage.includes(path))
    ) {
      fail();
    }
    const reviewFindings: unknown[] = review.findings;
    for (const f of reviewFindings) {
      if (!isRecord(f)) {
        fail();
      }
      originals.push({ ...f, id: role + ":" + f.id });
    }
  }
  if (
    current.some((e) => e.role === "tester" && isRecord(e.result) && e.result.passed === false) ||
    current.some((e) => e.role === "command" && (!isRecord(e.result) || e.result.code !== 0))
  ) {
    originals.push({
      id: "test-failure",
      blocking: true,
      confirmed: true,
      evidence: "Independent test gate failed",
    });
  }
  if (new Set(originals.map((f) => f.id)).size !== originals.length) {
    fail();
  }
  const audits = current.filter((e) => e.role === "docs");
  if (audits.length !== 1 || !isRecord(audits[0]?.result) || audits[0].result.changes !== false) {
    fail();
  }
  const triages = current.filter((e) => e.role === "triage");
  if (triages.length !== 1) {
    fail();
  }
  const triage = triages[0]?.result;
  const findings: unknown = isRecord(triage) ? triage.findings : undefined;
  if (
    !isRecord(triage) ||
    triage.complete !== true ||
    !text(triage.completionEvidence) ||
    !Array.isArray(findings) ||
    findings.length > MAX_TRIAGE_FINDINGS ||
    findings.length !== originals.length ||
    findings.some((f: unknown) => !isRecord(f)) ||
    new Set(findings.filter(isRecord).map((f) => f.id)).size !== originals.length ||
    s.findings.length !== findings.length
  ) {
    fail();
  }
  for (const original of originals) {
    const f: unknown = findings.find((x: unknown) => isRecord(x) && x.id === original.id);
    const saved = s.findings.find((x) => x.id === original.id);
    if (
      !isRecord(f) ||
      !saved ||
      typeof f.confirmed !== "boolean" ||
      (original.id === "test-failure" && (!f.confirmed || !f.blocking)) ||
      (original.blocking && f.confirmed && !f.blocking) ||
      (f.confirmed && f.blocking) ||
      f.blocking !== saved.blocking ||
      f.confirmed !== saved.confirmed ||
      f.evidence !== saved.evidence ||
      JSON.stringify(f.reproduction) !== JSON.stringify(saved.reproduction)
    ) {
      fail();
    }
  }
}

function validateRunFields(s: unknown): asserts s is Run {
  const optionalText = (x: unknown) => x === undefined || text(x);
  const fail: () => never = invalidState;
  if (
    !isRecord(s) ||
    s.version !== 2 ||
    !text(s.id) ||
    !/^[0-9a-f-]{36}$/.test(s.id) ||
    !text(s.request) ||
    !text(s.repo) ||
    !text(s.baseRevision) ||
    s.branch !== "factory/" + s.id ||
    ![
      "planning",
      "implementing",
      "testing",
      "reviewing",
      "repairing",
      "documenting",
      "delivering",
      "completed",
      "blocked",
      "failed",
    ].some((phase) => phase === s.phase) ||
    !["implement", "verify", "repair", "docs", "deliver"].some((step) => step === s.step)
  ) {
    fail();
  }
  if (
    s.location !== "worktree" ||
    (s.pauseSnapshot !== undefined &&
      (typeof s.pauseSnapshot !== "string" || !/^[0-9a-f]{64}$/.test(s.pauseSnapshot))) ||
    s.worktree === s.repo
  ) {
    fail();
  }
  if (
    (s.delivery !== "github" && s.delivery !== "local" && s.delivery !== undefined) ||
    (s.delivery === "local"
      ? s.target !== undefined
      : !isRecord(s.target) ||
        !text(s.target.repo) ||
        !text(s.target.base) ||
        !text(s.target.remote)) ||
    !integer(s.planRevision) ||
    s.planRevision < 1 ||
    !Array.isArray(s.plans) ||
    s.plans.length > s.planRevision ||
    s.plans.length < s.planRevision - 1
  ) {
    fail();
  }
  for (const plan of s.plans) {
    validatePlan(plan);
  }
  if (
    !integer(s.task) ||
    !integer(s.repairs) ||
    s.repairs > 5 ||
    !integer(s.round) ||
    !integer(s.updated) ||
    !["documented", "paused", "cancelled"].every((k) => typeof s[k] === "boolean") ||
    !optionalText(s.worktree) ||
    !optionalText(s.revision) ||
    !optionalText(s.error) ||
    !optionalText(s.deliveryIntent)
  ) {
    fail();
  }
  const currentPlan = s.plans.at(-1);
  if (s.plans.length && (!currentPlan || s.task > currentPlan.tasks.length)) {
    fail();
  }
  if (
    s.active !== undefined &&
    (!isRecord(s.active) ||
      !text(s.active.role) ||
      !text(s.active.requestId) ||
      !integer(s.active.started))
  ) {
    fail();
  }
  if (s.deliveryIntent && (!s.worktree || !s.revision || s.deliveryIntent !== s.revision)) {
    fail();
  }
  if (
    s.pr !== undefined &&
    (!isRecord(s.pr) || !text(s.pr.url) || !text(s.pr.head) || typeof s.pr.draft !== "boolean")
  ) {
    fail();
  }
  if (s.delivery === "local" ? !!s.pr : !!s.localReceipt) {
    fail();
  }
  if (
    s.localReceipt !== undefined &&
    (!isRecord(s.localReceipt) ||
      !text(s.localReceipt.revision) ||
      s.localReceipt.revision !== s.revision ||
      s.localReceipt.branch !== s.branch ||
      !s.worktree ||
      s.localReceipt.worktree !== s.worktree)
  ) {
    fail();
  }
  if (
    s.phase === "completed" &&
    (s.step !== "deliver" ||
      s.deliveryIntent ||
      (!s.noChanges &&
        (s.delivery === "local" ? !s.localReceipt : !isRecord(s.pr) || s.pr.head !== s.revision)))
  ) {
    fail();
  }
  if (
    s.step !== "implement" &&
    s.plans.length &&
    (!currentPlan || s.task !== currentPlan.tasks.length)
  ) {
    fail();
  }
  if (s.step === "deliver" && (!s.documented || !s.revision)) {
    fail();
  }
  if (s.documented && !s.revision) {
    fail();
  }
  if (
    [
      "implementing",
      "testing",
      "reviewing",
      "repairing",
      "documenting",
      "delivering",
      "completed",
    ].some((phase) => phase === s.phase) &&
    (!s.worktree || s.plans.length !== s.planRevision)
  ) {
    fail();
  }
  if (
    !Array.isArray(s.findings) ||
    s.findings.some(
      (f: unknown) =>
        !isRecord(f) ||
        !text(f.id) ||
        typeof f.blocking !== "boolean" ||
        !text(f.evidence) ||
        (f.confirmed !== undefined && typeof f.confirmed !== "boolean"),
    )
  ) {
    fail();
  }
  for (const f of s.findings) {
    if (f.reproduction !== undefined) {
      validateCommand(f.reproduction);
    }
  }
  if (!Array.isArray(s.executions) || !Array.isArray(s.evidence)) {
    fail();
  }
  const round = s.round;
  for (const list of [s.executions, s.evidence]) {
    if (
      !Array.isArray(list) ||
      list.some(
        (e: unknown) =>
          !isRecord(e) ||
          !text(e.role) ||
          !text(e.revision) ||
          !integer(e.round) ||
          e.round > round ||
          !integer(e.at) ||
          !Object.hasOwn(e, "result"),
      )
    ) {
      fail();
    }
  }
  for (const e of s.evidence as unknown[]) {
    if (!isRecord(e)) {
      fail();
    }
    const r = e.result;
    if (!isRecord(r)) {
      fail();
    }
    if (e.role === "command") {
      validateCommand(r.command);
      if (
        !Number.isInteger(r.code) ||
        typeof r.stdout !== "string" ||
        typeof r.stderr !== "string"
      ) {
        fail();
      }
    } else if (e.role === "tester") {
      if (
        typeof r.passed !== "boolean" ||
        typeof r.summary !== "string" ||
        !Array.isArray(r.commands)
      ) {
        fail();
      }
      for (const c of r.commands) {
        validateCommand(c);
      }
    } else if (["quality", "security", "ponytail"].some((role) => role === e.role)) {
      if (
        typeof r.summary !== "string" ||
        !Array.isArray(r.coverage) ||
        r.coverage.some((path: unknown) => !text(path)) ||
        !Array.isArray(r.findings) ||
        r.findings.length > MAX_REVIEW_FINDINGS ||
        r.findings.some(
          (f: unknown) =>
            !isRecord(f) || !text(f.id) || typeof f.blocking !== "boolean" || !text(f.evidence),
        )
      ) {
        fail();
      }
    } else if (e.role === "triage") {
      if (
        typeof r.complete !== "boolean" ||
        !text(r.completionEvidence) ||
        !Array.isArray(r.findings) ||
        r.findings.length > MAX_TRIAGE_FINDINGS ||
        r.findings.some(
          (f: unknown) =>
            !isRecord(f) ||
            !text(f.id) ||
            typeof f.blocking !== "boolean" ||
            typeof f.confirmed !== "boolean" ||
            !text(f.evidence),
        ) ||
        new Set(r.findings.filter(isRecord).map((f: Record<string, unknown>) => f.id)).size !==
          r.findings.length
      ) {
        fail();
      }
      for (const f of r.findings) {
        if (f.reproduction !== undefined) {
          validateCommand(f.reproduction);
        }
      }
    } else if (e.role === "docs") {
      if (typeof r.summary !== "string" || typeof r.changes !== "boolean") {
        fail();
      }
    } else if (e.role === "reproduction") {
      if (
        !text(r.id) ||
        !isRecord(r.result) ||
        !Number.isInteger(r.result.code) ||
        typeof r.result.stdout !== "string" ||
        typeof r.result.stderr !== "string"
      ) {
        fail();
      }
    } else {
      fail();
    }
  }
}

export function validateRun(s: unknown): asserts s is Run {
  validateRunFields(s);
  const fail: () => never = invalidState;
  if (s.step === "deliver") {
    validateFinalFindings(s);
    const current = s.evidence.filter(
      (e: Evidence) => e.round === s.round && e.revision === s.revision,
    );
    const commands = current.filter((e: Evidence) => e.role === "command");
    const plan = s.plans.at(-1);
    if (!plan) {
      fail();
    }
    const expected = plan.verification;
    if (
      commands.length !== expected.length ||
      commands.some(
        (e: Evidence, i: number) =>
          !isRecord(e.result) ||
          e.result.code !== 0 ||
          JSON.stringify(e.result.command) !== JSON.stringify(expected[i]),
      ) ||
      !current.some(
        (e: Evidence) => e.role === "tester" && isRecord(e.result) && e.result.passed === true,
      ) ||
      ["quality", "security", "ponytail"].some(
        (role) => !current.some((e: Evidence) => e.role === role),
      )
    ) {
      fail();
    }
  }
}

export function atomic(path: string, value: unknown) {
  const temp = path + "." + randomUUID() + ".tmp";
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

export class Store {
  dir: string;
  state?: Run;
  legacy?: Record<string, unknown> | undefined;
  private lock: number | undefined;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lockPath = join(dir, "writer.lock");
    // A dead PID is insufficient proof that a child has stopped. Never steal a lock.
    try {
      this.lock = openSync(lockPath, "wx", 0o600);
    } catch {
      throw new Error(
        `Factory writer lock exists: ${lockPath}. Inspect owner and child termination before removing it.`,
      );
    }
    writeFileSync(this.lock, JSON.stringify({ pid: process.pid, started: Date.now() }));
    try {
      const path = join(dir, "state.json");
      if (existsSync(path)) {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (isRecord(parsed) && parsed.version === 1) {
          if (!text(parsed.id) || !/^[0-9a-f-]{36}$/.test(parsed.id) || !text(parsed.phase)) {
            throw new Error("Invalid legacy factory state");
          }
          this.legacy = parsed;
          return;
        }
        validateRun(parsed);
        this.state = parsed;
        if (
          this.state.active ||
          this.state.deliveryIntent ||
          (!this.state.paused &&
            !this.state.cancelled &&
            !["completed", "failed", "blocked"].includes(this.state.phase))
        ) {
          this.state.phase = "blocked";
          this.state.error =
            "Interrupted operation is uncertain; inspect artifacts and reconcile before resuming.";
          this.save();
        }
      }
    } catch (e) {
      this.close();
      throw e;
    }
  }

  save() {
    if (this.lock === undefined) {
      throw new Error("Store is closed");
    }
    if (!this.state) {
      return;
    }
    this.state.updated = Date.now();
    atomic(join(this.dir, "state.json"), this.state);
  }

  archive() {
    if (this.legacy) {
      const path = join(this.dir, String(this.legacy.id) + ".json");
      const temp = path + "." + randomUUID() + ".tmp";
      atomic(temp, this.legacy);
      try {
        const matches = (candidate: string) => {
          try {
            return isDeepStrictEqual(JSON.parse(readFileSync(candidate, "utf8")), this.legacy);
          } catch (error) {
            if (error instanceof SyntaxError) {
              return false;
            }
            throw error;
          }
        };
        try {
          linkSync(temp, path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
          }
          const prefix = String(this.legacy.id) + "-legacy-";
          if (
            !matches(path) &&
            !readdirSync(this.dir).some(
              (name) =>
                name.startsWith(prefix) && name.endsWith(".json") && matches(join(this.dir, name)),
            )
          ) {
            while (true) {
              try {
                linkSync(temp, join(this.dir, prefix + randomUUID() + ".json"));
                break;
              } catch (collision) {
                if ((collision as NodeJS.ErrnoException).code !== "EEXIST") {
                  throw collision;
                }
              }
            }
          }
        }
      } finally {
        unlinkSync(temp);
      }
      this.legacy = undefined;
    }
    if (this.state) {
      atomic(join(this.dir, this.state.id + ".json"), this.state);
    }
  }

  close() {
    if (this.lock === undefined) {
      return;
    }
    closeSync(this.lock);
    this.lock = undefined;
    unlinkSync(join(this.dir, "writer.lock"));
  }
}
