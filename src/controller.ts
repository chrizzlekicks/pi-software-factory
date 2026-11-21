import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { Git, execute, validatePlan, validCommitSubject } from "./git.ts";
import {
  Store,
  validateFinalFindings,
  validateRun,
  MAX_REVIEW_FINDINGS,
  MAX_TRIAGE_FINDINGS,
} from "./state.ts";
import type { Run, Phase, Plan, Finding, Command } from "./state.ts";

export interface Agents {
  preflight(cwd: string): Promise<void>;
  run(
    role: string,
    task: string,
    cwd: string,
    identity: { requestId: string; ownerRunId: string; nodeId: string },
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface Delivery {
  preflight(): Promise<Run["target"]>;
  deliver(state: Run, report: string, boundary: () => void): Promise<NonNullable<Run["pr"]>>;
  reconcile?(state: Run, boundary: () => void, completed: boolean): Promise<NonNullable<Run["pr"]>>;
}

export class Factory {
  store: Store;
  git: Git;
  agents: Agents;
  delivery: Delivery;
  changed: (s: Run) => void;
  private running = false;
  private abort: AbortController | undefined;
  private pauseWanted = false;
  private cancelWanted = false;

  constructor(
    store: Store,
    git: Git,
    agents: Agents,
    delivery: Delivery,
    changed: (s: Run) => void = () => {},
  ) {
    this.store = store;
    this.git = git;
    this.agents = agents;
    this.delivery = delivery;
    this.changed = changed;
  }

  get state() {
    if (!this.store.state) {
      if (this.store.legacy) {
        throw new Error(
          "Legacy factory state cannot resume automatically; inspect preserved artifacts and start a fresh run",
        );
      }
      throw new Error("No factory run");
    }
    return this.store.state;
  }

  save(phase?: Phase) {
    if (phase) {
      this.state.phase = phase;
    }
    this.store.save();
    try {
      this.changed(this.state);
    } catch {}
  }

  private idle() {
    if (this.running) {
      throw new Error("Factory controller is busy");
    }
  }

  async request(request: string, delivery?: "github" | "local") {
    await this.plan(request, delivery);
    await this.drive();
  }

  async plan(request: string, delivery?: "github" | "local") {
    this.idle();
    if (!request.trim()) {
      throw new Error("A development request is required");
    }
    const old = this.store.state;
    if (this.store.legacy?.active || this.store.legacy?.deliveryIntent) {
      throw new Error(
        "Legacy run has an uncertain operation; inspect the preserved state and confirm all children stopped before starting a fresh run",
      );
    }
    if (old?.active || old?.deliveryIntent) {
      throw new Error("Prior operation is uncertain; reconcile before starting a new run");
    }
    if (old && !["completed", "failed"].includes(old.phase) && !old.cancelled) {
      throw new Error("Active run exists; inspect or cancel it first");
    }
    if (delivery === undefined) {
      const hasOrigin = this.git.git(["remote"]).split("\n").includes("origin");
      const origin = hasOrigin ? this.git.git(["remote", "get-url", "origin"]) : "";
      if (
        hasOrigin &&
        !/^(?:[a-z][a-z0-9+.-]*:\/\/(?:[^/@]+@)?github\.com(?=[:/]|$)|(?:[^/@:]+@)?github\.com:)/i.test(
          origin,
        )
      ) {
        throw new Error("Unsupported origin: delivery requires a github.com origin or no origin");
      }
      delivery = hasOrigin ? "github" : "local";
    }
    const baseRevision = this.git.head();
    const startingBranch =
      delivery === "github" ? this.git.git(["symbolic-ref", "--short", "HEAD"]) : undefined;
    this.pauseWanted = false;
    this.cancelWanted = false;
    this.running = true;
    try {
      if (delivery !== "github" && delivery !== "local") {
        throw new Error("Invalid delivery mode");
      }
      if (delivery === "local") {
        this.git.head();
        for (const key of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
          this.git.git(["var", key]);
        }
      }
      const target = delivery === "github" ? await this.delivery.preflight() : undefined;
      if (delivery === "github" && !target) {
        throw new Error("GitHub preflight did not provide a delivery target");
      }
      if (
        target &&
        (this.git.head() !== baseRevision ||
          this.git.git(["symbolic-ref", "--short", "HEAD"]) !== startingBranch)
      ) {
        throw new Error("Starting branch changed before GitHub preflight");
      }
      this.boundary();
      this.store.archive();
      const id = randomUUID();
      this.store.state = {
        version: 2,
        location: "worktree",
        id,
        request,
        repo: this.git.repo,
        baseRevision,
        phase: "planning",
        planRevision: 1,
        plans: [],
        branch: "factory/" + id,
        delivery,
        target,
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
        updated: Date.now(),
      };
      this.state.active = { role: "worktree-create", requestId: randomUUID(), started: Date.now() };
      this.save();
      this.state.worktree = this.git.create(this.state);
      this.state.revision = baseRevision;
      this.state.active = undefined;
      this.save();
      await this.agents.preflight(this.checkout(this.state));
      const snapshot = this.git.snapshot(this.state);
      const plan = validatePlan(
        await this.agent(
          "planner",
          `Delegate repository inspection to scout and, when useful, web research to researcher, instructing it to call web_enable first. Do not implement changes. Plan this request: ${request}\nReturn dependencies, risks, exact allowed file paths (directory prefixes end in /), ordered tasks and concrete build/test/black-box verification commands as executable + argv. Include documentation paths. Propose at least one task, file path and verification command; make reasonable assumptions and record them in risks. No implementation.`,
        ),
      );
      this.boundary();
      if (this.git.snapshot(this.state) !== snapshot) {
        throw new Error("Planner changed worktree");
      }
      this.state.plans.push(plan);
      this.save("implementing");
    } catch (e) {
      if (this.store.state && this.store.state !== old) {
        this.state.error = String(e);
        if (this.cancelWanted) {
          this.state.cancelled = true;
          this.state.paused = true;
        } else if (this.pauseWanted) {
          this.state.paused = true;
        }
        this.save("failed");
        writeFileSync(join(this.store.dir, "report.md"), this.report(), { mode: 0o600 });
      }
      throw e;
    } finally {
      this.running = false;
    }
  }

  private recordPause() {
    const s = this.state;
    s.paused = true;
    s.pauseSnapshot = undefined;
    if (s.worktree && !s.active) {
      try {
        s.pauseSnapshot = this.git.snapshot(s);
      } catch (e) {
        s.error = "Pause snapshot failed; inspected recovery required: " + String(e);
      }
    }
  }

  pause() {
    this.pauseWanted = true;
    if (!this.running) {
      this.recordPause();
      this.save();
    }
  }

  cancel() {
    this.cancelWanted = true;
    this.abort?.abort();
    if (!this.running) {
      this.state.cancelled = true;
      this.state.paused = true;
      this.save("blocked");
    }
  }

  async resume() {
    this.idle();
    const s = this.state;
    if (s.active || s.deliveryIntent) {
      throw new Error(
        "Uncertain operation: inspect artifacts. Reconcile with the explicit recovery procedure; no automatic replay.",
      );
    }
    if (s.cancelled || ["completed", "failed"].includes(s.phase)) {
      throw new Error("Cancelled or terminal run cannot resume");
    }
    if (s.phase === "blocked" && !s.paused) {
      throw new Error("Quality gate blocked; inspect findings, do not bypass it");
    }
    this.git.unchanged(s, this.currentRevision(s));
    if (s.paused && (!s.pauseSnapshot || this.git.snapshot(s) !== s.pauseSnapshot)) {
      throw new Error("Paused checkout changed or snapshot unavailable; inspect and replan");
    }
    if (["testing", "reviewing"].includes(s.phase) || s.step === "deliver") {
      s.step = "verify";
    }
    this.pauseWanted = false;
    s.paused = false;
    s.pauseSnapshot = undefined;
    s.error = undefined;
    this.save();
  }

  async deliver() {
    this.idle();
    const s = this.state;
    const completed = s.phase === "completed";
    if (
      s.active ||
      s.cancelled ||
      s.noChanges ||
      s.step !== "deliver" ||
      (!completed && (s.phase !== "blocked" || !s.deliveryIntent)) ||
      (completed && s.deliveryIntent)
    ) {
      throw new Error(
        "Delivery retry requires a finalized delivery intent or completed receipt and no uncertain child",
      );
    }
    validateRun(s);
    const revision = this.currentRevision(s);
    if (
      !s.candidateSnapshot ||
      revision === s.baseRevision ||
      this.git.git(["rev-list", "--parents", "-n", "1", revision], this.checkout(s)) !==
        `${revision} ${s.baseRevision}`
    ) {
      throw new Error("Missing finalization evidence or invalid final commit parent");
    }
    const verify = () => {
      this.git.unchanged(s, revision);
      if (!this.git.clean(this.checkout(s))) {
        throw new Error("Delivery worktree is dirty");
      }
      this.finalGate(true);
    };
    verify();
    if (s.paused && (!s.pauseSnapshot || this.git.snapshot(s) !== s.pauseSnapshot)) {
      throw new Error("Paused checkout changed or snapshot unavailable; inspect and replan");
    }
    this.pauseWanted = false;
    s.paused = false;
    s.pauseSnapshot = undefined;
    const mode = s.delivery;
    const target = JSON.stringify(s.target);
    this.running = true;
    try {
      if (!completed) {
        s.deliveryIntent = revision;
        this.save();
      }
      const boundary = () => {
        this.boundary();
        verify();
        if (s.delivery !== mode || JSON.stringify(s.target) !== target) {
          throw new Error("Delivery target changed");
        }
      };
      if (mode === "local") {
        if (s.target || s.pr) {
          throw new Error("Invalid local delivery state");
        }
        const receipt = { revision, branch: s.branch, worktree: this.checkout(s) };
        if (s.localReceipt && JSON.stringify(s.localReceipt) !== JSON.stringify(receipt)) {
          throw new Error("Local receipt mismatch");
        }
        s.localReceipt = receipt;
      } else {
        if (!this.delivery.reconcile) {
          throw new Error("Delivery reconciliation unavailable");
        }
        const receipt = await this.delivery.reconcile(s, boundary, completed);
        boundary();
        if (s.pr && (s.pr.url !== receipt.url || s.pr.head !== receipt.head)) {
          throw new Error("PR receipt mismatch");
        }
        if (!completed) {
          s.pr = receipt;
        }
      }
      if (!completed) {
        this.save(); // Persist the receipt while the intent still protects recovery.
        s.deliveryIntent = undefined;
        s.error = undefined;
        this.save("completed");
      }
      writeFileSync(join(this.store.dir, "report.md"), this.report(), { mode: 0o600 });
    } catch (e) {
      if (!completed) {
        s.deliveryIntent = revision;
        s.error = `Delivery retry: ${String(e)}`;
        if (this.cancelWanted) {
          s.cancelled = true;
          s.paused = true;
        } else if (this.pauseWanted) {
          this.recordPause();
          this.pauseWanted = false;
        }
        this.save("blocked");
        writeFileSync(join(this.store.dir, "report.md"), this.report(), { mode: 0o600 });
      }
      throw e;
    } finally {
      this.running = false;
    }
  }

  private get planValue(): Plan {
    const plan = this.state.plans.at(-1);
    if (!plan) {
      throw new Error("No current plan");
    }
    return plan;
  }

  private currentRevision(s: Run): string {
    const revision = s.revision;
    if (!revision) {
      throw new Error("No current revision");
    }
    return revision;
  }

  private checkout(s: Run): string {
    const worktree = s.worktree;
    if (!worktree) {
      throw new Error("No isolated checkout");
    }
    return worktree;
  }

  private boundary() {
    if (this.cancelWanted || this.pauseWanted) {
      throw new Error("Stop requested at safe boundary");
    }
  }

  private async agent(role: string, task: string) {
    this.boundary();
    const s = this.state;
    const identity = {
      requestId: randomUUID(),
      ownerRunId: s.id,
      nodeId: `${role}-${s.executions.length}`,
    };
    s.active = { role, requestId: identity.requestId, started: Date.now() };
    this.save();
    this.abort = new AbortController();
    const revision = s.worktree ? this.git.head(s.worktree) : s.baseRevision;
    const readonly = ["tester", "quality", "security", "ponytail", "docs", "triage"].includes(role);
    const snapshot = readonly ? this.git.snapshot(s) : undefined;
    const result = await this.agents.run(role, task, this.checkout(s), identity, this.abort.signal);
    if (readonly && this.git.snapshot(s) !== snapshot) {
      throw new Error(`${role} changed the candidate; evidence invalid`);
    }
    this.git.unchanged(s, revision);
    s.executions.push({ role, revision, round: s.round, result, at: Date.now() });
    s.active = undefined;
    this.abort = undefined;
    this.save();
    return result;
  }

  private async mutation(role: string, task: string) {
    const s = this.state;
    this.git.unchanged(s, this.currentRevision(s));
    const before = this.git.head(this.checkout(s));
    const result = (await this.agent(
      role,
      `${task}\nCurrent validated plan revision ${s.planRevision}: ${JSON.stringify(this.planValue)}\nReport necessary scope changes in scopeChange. Install project-defined dependencies if needed. Never commit, push, create PRs, change branches/worktrees, alter Git metadata, or weaken verification. Preserve existing changes. Return summary and scopeChange (empty when none).`,
    )) as { summary: string; scopeChange: string };
    if (this.git.head(this.checkout(s)) !== before) {
      throw new Error("Worker changed Git HEAD; inspect before recovery");
    }
    if (!result || typeof result.summary !== "string" || typeof result.scopeChange !== "string") {
      throw new Error("Invalid worker outcome");
    }
    const extra = this.git
      .changed(s)
      .filter(
        (path) =>
          !this.planValue.files.some((f) => (f.endsWith("/") ? path.startsWith(f) : path === f)),
      );
    if (result.scopeChange || extra.length) {
      if (role !== "repair") {
        if (s.repairs >= 5) {
          throw new Error("Five repair cycles exhausted during scope revision");
        }
        s.repairs++;
      }
      const snapshot = this.git.snapshot(s);
      const previous = this.planValue;
      const revised = validatePlan(
        await this.agent(
          "planner",
          `READ ONLY revise scope and verification for request ${s.request}. Existing plan: ${JSON.stringify(previous)}. Changed paths: ${JSON.stringify(this.git.changed(s))}. Requested revision: ${result.scopeChange}. Include every changed path; preserve or strengthen verification. Do not edit.`,
        ),
      );
      if (this.git.snapshot(s) !== snapshot) {
        throw new Error("Planner changed the candidate during scope revision");
      }
      if (
        previous.verification.some(
          (old) =>
            !revised.verification.some((next) => JSON.stringify(next) === JSON.stringify(old)),
        )
      ) {
        throw new Error("Scope revision removed an existing verification command");
      }
      revised.tasks = previous.tasks;
      validatePlan(revised);
      this.git.scope(s, revised);
      s.plans.push(revised);
      s.planRevision++;
    }
    this.git.unchanged(s, s.baseRevision);
    this.save();
  }

  private evidence(role: string, result: unknown) {
    this.state.evidence.push({
      role,
      revision: this.currentRevision(this.state),
      round: this.state.round,
      result,
      at: Date.now(),
    });
    this.save();
  }

  private async command(c: Command) {
    this.boundary();
    const s = this.state;
    s.active = { role: "verification-command", requestId: randomUUID(), started: Date.now() };
    this.save();
    this.abort = new AbortController();
    const snapshot = this.git.snapshot(s);
    const result = await execute(c.command, c.args, this.checkout(s), this.abort.signal);
    if (this.git.snapshot(s) !== snapshot) {
      throw new Error("Verification command changed the candidate; evidence invalid");
    }
    s.active = undefined;
    this.abort = undefined;
    this.git.unchanged(s, this.currentRevision(s));
    this.evidence("command", { command: c, ...result });
    return result;
  }

  private async tests() {
    const s = this.state;
    this.save("testing");
    this.git.unchanged(s, this.currentRevision(s));
    const result = (await this.agent(
      "tester",
      `Independently verify revision ${s.revision}. Run all validated commands: ${JSON.stringify(this.planValue.verification)}. Include build, tests and black-box smoke tests as applicable. Do not edit tracked files/install dependencies or weaken tests. Return passed, summary, commands actually run. Missing verification is a failure.`,
    )) as { passed: boolean; summary: string; commands: Command[] };
    this.git.unchanged(s, this.currentRevision(s));
    if (
      !result ||
      typeof result.passed !== "boolean" ||
      typeof result.summary !== "string" ||
      !Array.isArray(result.commands)
    ) {
      throw new Error("Invalid tester evidence");
    }
    this.evidence("tester", result);
    let passed = result.passed;
    for (const c of this.planValue.verification) {
      // oxlint-disable-next-line no-await-in-loop -- Approved commands run in plan order against the same checkout.
      if ((await this.command(c)).code !== 0) {
        passed = false;
      }
    }
    return passed;
  }

  private async reviews() {
    const s = this.state;
    this.save("reviewing");
    const findings: Finding[] = [];
    const paths = this.git.changed(s);
    s.reviewPaths = paths;
    this.save();
    const material = join(this.store.dir, `review-${s.id}-${s.round}.md`);
    writeFileSync(material, this.git.reviewText(s), { mode: 0o600 });
    if (this.git.snapshot(s) !== s.candidateSnapshot) {
      throw new Error("Candidate changed while preparing review");
    }
    for (const role of ["quality", "security", "ponytail"]) {
      const focus =
        role === "quality"
          ? "architecture, code quality and simplicity"
          : role === "security"
            ? "correctness, security, silent bugs and edge cases"
            : "the installed ponytail-review skill: independently review correctness, safety, load, tests and unnecessary code";
      let correction = "";
      let r: { summary: string; findings: Finding[]; coverage: string[] };
      while (true) {
        // oxlint-disable-next-line no-await-in-loop -- Each attempt is checked and persisted before the next.
        r = (await this.agent(
          role,
          `Independent adversarial READ-ONLY review of ${s.worktree}, changes from ${s.baseRevision}. Focus on ${focus}. Read the entire review material at ${material}, using read offsets and limits to page large text, and inspect connected code. Fully inspect every changed path: ${JSON.stringify(paths)}. Plan: ${JSON.stringify(this.planValue)}. Return summary, findings with unique id, blocking boolean and concrete evidence/file paths. Coverage must contain only the exact repository-relative changed path strings, each once, with no descriptions, artifact paths or context paths; mention context separately in summary or findings. Never claim coverage of unreadable or uninspected material. No shell or edits. ${correction}`,
        )) as { summary: string; findings: Finding[]; coverage: string[] };
        this.git.unchanged(s, this.currentRevision(s));
        if (this.git.snapshot(s) !== s.candidateSnapshot) {
          throw new Error("Candidate changed during review; evidence invalid");
        }
        validateFindings(r?.findings);
        if (typeof r.summary !== "string") {
          throw new Error(`Invalid ${role} review summary`);
        }
        const coverage = Array.isArray(r.coverage) ? r.coverage : [];
        const missing = paths.filter((p) => !coverage.includes(p));
        const invalid = coverage.filter((p, i) => !paths.includes(p) || coverage.indexOf(p) !== i);
        if (Array.isArray(r.coverage) && !missing.length && !invalid.length) {
          break;
        }
        const diagnostic = `Incomplete ${role} review coverage: expected ${JSON.stringify(paths)}; missing ${JSON.stringify(missing)}; invalid or duplicate ${JSON.stringify(invalid)}${Array.isArray(r.coverage) ? "" : "; coverage is not an array"}`;
        if (s.repairs >= 5) {
          throw new Error(`${diagnostic}; five repair cycles exhausted`);
        }
        s.repairs++;
        this.save();
        correction = `Previous response was invalid: ${diagnostic}. Reinspect the material and changed paths before responding; do not invent coverage. If anything is unreadable or uninspected, omit it from coverage.`;
      }
      this.evidence(role, r);
      findings.push(...r.findings.map((f) => ({ ...f, id: role + ":" + f.id })));
    }
    return findings;
  }

  private async triage(findings: Finding[], testsPassed: boolean) {
    const s = this.state;
    if (!testsPassed) {
      findings.push({
        id: "test-failure",
        blocking: true,
        confirmed: true,
        evidence: "Independent test gate failed",
      });
    }
    const evidence = s.evidence
      .filter((e) => e.round === s.round)
      .map((e, index) => {
        const result = isRecord(e.result) ? e.result : {};
        if (e.role === "command") {
          const artifact = join(this.store.dir, `command-${s.id}-${s.round}-${index}.jsonl`);
          const lines: string[] = [];
          for (const stream of ["stdout", "stderr"] as const) {
            const output = typeof result[stream] === "string" ? result[stream] : "";
            for (let offset = 0; offset < output.length || offset === 0; offset += 4000) {
              lines.push(
                JSON.stringify({ stream, offset, text: output.slice(offset, offset + 4000) }),
              );
            }
          }
          writeFileSync(artifact, lines.join("\n") + "\n", { mode: 0o600 });
          return { role: e.role, command: result.command, code: result.code, artifact };
        }
        return { role: e.role, passed: result.passed, changes: result.changes };
      });
    const result = (await this.agent(
      "triage",
      `READ ONLY determine whether the full request is complete, with concrete completionEvidence. Provide commitSubject describing the actual full verified task delta, not the request or plan title: one meaningful Conventional Commits line, type[(scope)][!]: description, at most 72 characters; type must be docs, fix, feat, refactor, test, chore, build, ci, perf, revert or style. Base it on the complete change material and verification evidence. Request: ${s.request}. Plan: ${JSON.stringify(this.planValue)}. Changed paths: ${JSON.stringify(this.git.changed(s))}. Complete paged change material: ${join(this.store.dir, `review-${s.id}-${s.round}.md`)}. Verification and review status: ${JSON.stringify(evidence)}. Command output artifacts contain ordered JSON lines with stream, character offset, and text; page with read offsets and limits. Consolidate these findings: ${JSON.stringify(findings)}. Confirm suspected defects with concrete source evidence. Reject only with explicit contradictory evidence. Return EVERY original id exactly once, blocking, confirmed boolean, evidence, and optional reproduction executable/argv using ONLY a planned verification command from ${JSON.stringify(this.planValue.verification)}. Test-failure cannot be rejected. No edits or shell.`,
    )) as {
      findings: Finding[];
      complete: boolean;
      completionEvidence: string;
      commitSubject: string;
    };
    this.git.unchanged(s, this.currentRevision(s));
    if (!validCommitSubject(result?.commitSubject)) {
      throw new Error("Invalid final commit subject; gate remains closed");
    }
    validateFindings(result?.findings, MAX_TRIAGE_FINDINGS);
    if (
      typeof result.complete !== "boolean" ||
      typeof result.completionEvidence !== "string" ||
      !result.completionEvidence.trim() ||
      result.findings.length !== findings.length ||
      new Set(result.findings.map((f) => f.id)).size !== findings.length ||
      findings.some((f) => !result.findings.some((r) => r.id === f.id)) ||
      result.findings.some((f) => typeof f.confirmed !== "boolean")
    ) {
      throw new Error("Incomplete triage; gate remains closed");
    }
    for (const f of result.findings) {
      if (f.id === "test-failure" || f.id === "docs-audit") {
        f.blocking = true;
        f.confirmed = true;
      }
      const original = findings.find((x) => x.id === f.id);
      if (!original) {
        throw new Error("Triage finding has no original");
      }
      if (original.blocking && f.confirmed) {
        f.blocking = true;
      }
      const reproduction = f.reproduction;
      if (reproduction) {
        const c = this.planValue.verification.find(
          (candidate) =>
            candidate.command === reproduction.command &&
            JSON.stringify(candidate.args) === JSON.stringify(reproduction.args),
        );
        if (!c) {
          throw new Error("Reproduction command is outside the validated plan");
        }
        // oxlint-disable-next-line no-await-in-loop -- Persist each reproduction before executing the next finding's command.
        this.evidence("reproduction", { id: f.id, result: await this.command(c) });
      }
    }
    s.findings = [...result.findings];
    this.evidence("triage", result);
    if (!result.complete) {
      s.findings.push({
        id: "task-incomplete",
        blocking: true,
        confirmed: true,
        evidence: result.completionEvidence,
      });
    }
    return !result.complete || s.findings.some((f) => f.confirmed && f.blocking);
  }

  async drive() {
    this.idle();
    const s = this.state;
    if (
      s.active ||
      s.cancelled ||
      s.paused ||
      ["completed", "failed", "blocked"].includes(s.phase)
    ) {
      throw new Error("Run is not runnable");
    }
    const delivery = s.delivery;
    const target = JSON.stringify(s.target);
    this.running = true;
    try {
      while (true) {
        if (this.cancelWanted) {
          s.cancelled = true;
          s.paused = true;
          this.save("blocked");
          return;
        }
        if (this.pauseWanted) {
          this.recordPause();
          this.pauseWanted = false;
          this.save();
          return;
        }
        if (s.delivery !== delivery || JSON.stringify(s.target) !== target) {
          throw new Error("Delivery selection changed during execution");
        }
        this.git.unchanged(s, this.currentRevision(s));
        if (s.step === "implement") {
          this.save("implementing");
          if (s.task < this.planValue.tasks.length) {
            const task = this.planValue.tasks[s.task];
            if (task === undefined) {
              throw new Error("Task index out of range");
            }
            // oxlint-disable-next-line no-await-in-loop -- Finish the current task checkpoint before advancing its durable index.
            await this.mutation("worker", task);
            s.task++;
            this.save();
            continue;
          }
          s.step = "verify";
          this.save();
        } else if (s.step === "verify") {
          s.round++;
          s.candidateSnapshot = this.git.snapshot(s);
          this.save();
          // oxlint-disable-next-line no-await-in-loop -- Verification must finish before reviews consume its evidence.
          const passed = await this.tests();
          // oxlint-disable-next-line no-await-in-loop -- Reviews follow verification and finish before triage.
          const findings = await this.reviews();
          this.save("documenting");
          // oxlint-disable-next-line no-await-in-loop -- Audit the same candidate as the other gates.
          const docs = (await this.agent(
            "docs",
            `READ ONLY audit documentation against request ${s.request} and the full implementation. Return summary and whether changes are needed. No edits or shell.`,
          )) as { summary: string; changes: boolean };
          this.git.unchanged(s, this.currentRevision(s));
          if (
            !docs ||
            typeof docs.summary !== "string" ||
            typeof docs.changes !== "boolean" ||
            (docs.changes && !docs.summary.trim())
          ) {
            throw new Error("Invalid documentation audit");
          }
          this.evidence("docs", docs);
          s.documented = !docs.changes;
          if (docs.changes) {
            findings.push({
              id: "docs-audit",
              blocking: true,
              confirmed: true,
              evidence: docs.summary,
            });
          }
          // oxlint-disable-next-line no-await-in-loop -- Triage depends on completed tester and reviewer evidence.
          if (await this.triage(findings, passed)) {
            if (s.repairs >= 5) {
              throw new Error("Five repair cycles exhausted");
            }
            s.step = "repair";
            this.save();
            continue;
          }
          s.step = "deliver";
          this.save();
        } else if (s.step === "repair") {
          this.save("repairing");
          s.repairs++;
          this.save();
          // oxlint-disable-next-line no-await-in-loop -- Complete and checkpoint repairs before starting the next verification round.
          await this.mutation(
            "repair",
            `Repair only confirmed blocking findings: ${JSON.stringify(s.findings)}`,
          );
          s.step = "verify";
          s.documented = false;
          this.save();
        } else if (s.step === "deliver") {
          this.save("delivering");
          this.finalGate();
          if (this.cancelWanted || this.pauseWanted) {
            continue;
          }
          s.active = { role: "finalize", requestId: randomUUID(), started: Date.now() };
          this.save();
          const snapshot = s.candidateSnapshot;
          if (!snapshot) {
            throw new Error("Missing accepted candidate snapshot");
          }
          const triage = s.evidence.find((e) => e.round === s.round && e.role === "triage")?.result;
          const subject = isRecord(triage) ? triage.commitSubject : undefined;
          if (!validCommitSubject(subject)) {
            throw new Error("Invalid final commit subject; gate remains closed");
          }
          const finalRevision = this.git.finalize(s, snapshot, subject);
          s.active = undefined;
          if (!finalRevision) {
            s.noChanges = true;
            this.save("completed");
            writeFileSync(join(this.store.dir, "report.md"), this.report(), { mode: 0o600 });
            return;
          }
          s.revision = finalRevision;
          for (const evidence of s.evidence.filter((e) => e.round === s.round)) {
            evidence.revision = finalRevision;
          }
          const revision = finalRevision;
          s.deliveryIntent = revision;
          this.save();
          if (s.delivery !== delivery || JSON.stringify(s.target) !== target) {
            throw new Error("Delivery selection changed during execution");
          }
          if (s.delivery === "local") {
            this.boundary();
            if (s.pr || s.localReceipt || s.target) {
              throw new Error("Invalid local delivery state");
            }
            this.git.unchanged(s, revision);
            s.localReceipt = { revision, branch: s.branch, worktree: this.checkout(s) };
          } else {
            // oxlint-disable-next-line no-await-in-loop -- Delivery runs only after its final gate and durable intent are recorded.
            s.pr = await this.delivery.deliver(s, this.report(), () => {
              this.boundary();
              if (s.delivery !== delivery || JSON.stringify(s.target) !== target) {
                throw new Error("Delivery selection changed during execution");
              }
              this.git.unchanged(s, revision);
            });
            if (!s.pr.draft || s.pr.head !== s.revision || !s.pr.url.startsWith("https://")) {
              throw new Error("Invalid draft PR receipt");
            }
          }
          this.save();
          s.deliveryIntent = undefined;
          try {
            this.save("completed");
          } catch (e) {
            s.deliveryIntent = revision;
            throw e;
          }
          writeFileSync(join(this.store.dir, "report.md"), this.report(), { mode: 0o600 });
          return;
        } else {
          throw new Error("Unknown controller step");
        }
      }
    } catch (e) {
      s.error = `Stage ${s.phase}: ${String(e)}`;
      if (this.cancelWanted) {
        s.cancelled = true;
        s.paused = true;
      } else if (this.pauseWanted) {
        this.recordPause();
        this.pauseWanted = false;
      }
      this.save("blocked");
      writeFileSync(join(this.store.dir, "report.md"), this.report(), { mode: 0o600 });
    } finally {
      this.running = false;
    }
  }

  private finalGate(finalized = false) {
    const s = this.state;
    this.git.unchanged(s, this.currentRevision(s));
    const changed = this.git.changed(s);
    if (
      !s.reviewPaths ||
      s.reviewPaths.length !== changed.length ||
      changed.some((path) => !s.reviewPaths?.includes(path))
    ) {
      throw new Error("Review coverage does not match changed paths");
    }
    if (!s.candidateSnapshot || (!finalized && this.git.snapshot(s) !== s.candidateSnapshot)) {
      throw new Error("Candidate changed since verification");
    }
    validateFinalFindings(s);
    if (!s.documented || s.findings.some((f) => f.blocking && f.confirmed)) {
      throw new Error("Final quality gate failed");
    }
    const current = s.evidence.filter((e) => e.revision === s.revision && e.round === s.round);
    for (const role of ["tester", "quality", "security", "ponytail", "docs", "triage"]) {
      if (!current.some((e) => e.role === role)) {
        throw new Error("Missing final evidence: " + role);
      }
    }
    const commands = current.filter((e) => e.role === "command");
    if (
      commands.length !== this.planValue.verification.length ||
      commands.some(
        (e, i) =>
          !isRecord(e.result) ||
          e.result.code !== 0 ||
          JSON.stringify(e.result.command) !== JSON.stringify(this.planValue.verification[i]),
      ) ||
      !current.some((e) => e.role === "tester" && isRecord(e.result) && e.result.passed === true)
    ) {
      throw new Error("Final verification did not pass");
    }
    for (const role of ["quality", "security", "ponytail"]) {
      const review = current.find((e) => e.role === role)?.result;
      if (!isRecord(review)) {
        throw new Error("Invalid final review");
      }
      validateFindings(review.findings);
      if (typeof review.summary !== "string") {
        throw new Error("Invalid final review");
      }
    }
  }

  report() {
    const s = this.state;
    const plan = s.plans.at(-1);
    const findings =
      s.findings
        .map(
          (f) =>
            `- ${f.confirmed === false ? "Rejected" : f.blocking ? "Blocking" : "Minor"}: ${f.evidence}`,
        )
        .join("\n") || (s.error ? "- No accepted findings recorded" : "- None");
    const checks =
      [...new Set(s.evidence.filter((e) => e.round === s.round).map((e) => e.role))].join(", ") ||
      "None completed";
    const missingReviews = ["quality", "security", "ponytail"].filter(
      (role) => !s.evidence.some((e) => e.round === s.round && e.role === role),
    );
    return `# Factory outcome: ${s.phase === "blocked" && s.deliveryIntent ? "delivery failed" : s.phase}${s.noChanges ? " (already satisfied)" : ""}${s.cancelled ? " (cancelled)" : s.paused ? " (paused)" : ""}\n\n## Request\n${s.request}\n\n## Plan/task summary\n${plan?.summary ?? "Not yet planned"}\n\n## Assumptions and risks\n${plan?.risks.map((r) => `- ${r}`).join("\n") || "- None recorded"}\n\n## Checks\n${checks}. Repair rounds: ${s.repairs}/5.\nReviewer evidence absent: ${missingReviews.join(", ") || "none"}.\n\n## Issues\n${s.error ? `- ${s.error}\n` : ""}${findings}\n\n## Delivery\nBranch: ${s.branch}\nRevision (${s.deliveryIntent ? "final" : s.localReceipt || s.pr ? "delivered" : "current/base; not necessarily a final commit"}): ${s.revision ?? s.baseRevision}\nPR: ${s.pr?.url ?? "none"}\nWorktree: ${s.worktree ?? "not created"}\nOriginal checkout changes were excluded. Local artifacts: ${this.store.dir}\n`;
  }
}

function validateFindings(value: unknown, max = MAX_REVIEW_FINDINGS): asserts value is Finding[] {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    value.some(
      (f) =>
        !f ||
        typeof f.id !== "string" ||
        !f.id.trim() ||
        typeof f.blocking !== "boolean" ||
        typeof f.evidence !== "string" ||
        !f.evidence.trim(),
    ) ||
    new Set(value.map((f) => f.id)).size !== value.length
  ) {
    throw new Error("Invalid review findings");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
