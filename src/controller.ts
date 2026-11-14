import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Git, execute, validatePlan } from "./git.ts";
import { Store, validateFinalFindings, approvalMatches } from "./state.ts";
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

  async plan(request: string, delivery: "github" | "local" = "local") {
    this.idle();
    if (!request.trim()) {
      throw new Error("A development request is required");
    }
    const old = this.store.state;
    if (old?.active || old?.deliveryIntent) {
      throw new Error("Prior operation is uncertain; reconcile before starting a new run");
    }
    if (
      old &&
      !["completed", "failed"].includes(old.phase) &&
      !old.cancelled &&
      old.phase !== "awaiting_approval"
    ) {
      throw new Error("Active run exists; inspect or cancel it first");
    }
    if (!this.git.clean()) {
      throw new Error("Start from a clean repository; user changes are never stashed or discarded");
    }
    this.pauseWanted = false;
    this.cancelWanted = false;
    this.running = true;
    try {
      await this.agents.preflight(this.git.repo);
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
      this.boundary();
      this.store.archive();
      const id = randomUUID();
      this.store.state = {
        version: 1,
        location: "checkout",
        id,
        request,
        repo: this.git.repo,
        baseRevision: this.git.head(),
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
      this.save();
      const plan = validatePlan(
        await this.agent(
          "planner",
          `Delegate repository inspection to scout and, when useful, web research to researcher, instructing it to call web_enable first. Do not implement changes. Plan this request: ${request}\nReturn dependencies, risks, exact allowed file paths (directory prefixes end in /), ordered tasks and concrete build/test/black-box verification commands as executable + argv. Include documentation paths. Propose at least one task, file path and verification command; these are proposals for human approval, not already-approved scope. No implementation.`,
        ),
      );
      this.boundary();
      if (!this.git.clean() || this.git.head() !== this.state.baseRevision) {
        throw new Error("Planner changed repository");
      }
      this.state.plans.push(plan);
      this.save("awaiting_approval");
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
      }
      throw e;
    } finally {
      this.running = false;
    }
  }

  reject() {
    this.idle();
    if (this.state.phase !== "awaiting_approval") {
      throw new Error("No plan awaiting approval");
    }
    this.state.approvedRevision = undefined;
    this.state.approvedDelivery = undefined;
    this.state.cancelled = true;
    this.state.error = "Plan rejected; submit a revised request";
    this.save("blocked");
  }

  async approve() {
    this.idle();
    const s = this.state;
    if (s.phase !== "awaiting_approval" || s.cancelled || s.active) {
      throw new Error("No current plan awaiting approval");
    }
    const plan = validatePlan(s.plans.at(-1));
    if (s.location !== "checkout") {
      throw new Error("Legacy execution location: inspect original worktree and recover manually");
    }
    if (
      s.worktree
        ? !s.recoverySnapshot || this.git.snapshot(s) !== s.recoverySnapshot
        : this.git.head() !== s.baseRevision || !this.git.clean()
    ) {
      throw new Error("Repository changed since planning; inspect and replan");
    }
    await this.agents.preflight(s.worktree ?? s.repo);
    this.boundary();
    if (s.cancelled || s.paused) {
      throw new Error("Stop requested during approval");
    }
    if (s.worktree) {
      if (this.git.snapshot(s) !== s.recoverySnapshot) {
        throw new Error("Checkout changed during approval");
      }
      this.git.scope(s, plan);
    }
    s.approvedRevision = s.planRevision;
    s.approvedDelivery = s.delivery ?? "github";
    s.delivery ??= "github";
    s.active = {
      role: s.worktree ? "checkpoint" : "branch-create",
      requestId: randomUUID(),
      started: Date.now(),
    };
    this.save("blocked");
    if (!s.worktree) {
      s.worktree = this.git.create(s);
      s.revision = s.baseRevision;
      s.active = undefined;
      this.save();
    } else {
      s.revision = this.git.checkpoint(s, plan);
      s.recoverySnapshot = undefined;
      s.active = undefined;
      this.save();
    }
    s.paused = false;
    s.error = undefined;
    this.save("implementing");
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
    if (!approvalMatches(s)) {
      throw new Error("Plan approval required");
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

  // Explicitly adopt an inspected interrupted checkout, but never assume the task completed.
  async replanAfterInterruption() {
    this.idle();
    const s = this.state;
    const initialPlanner =
      !s.worktree &&
      s.location === "checkout" &&
      (s.active?.role === "planner" ||
        (!s.active && (s.phase === "failed" || s.phase === "blocked"))) &&
      s.plans.length === 0 &&
      !s.approvedRevision &&
      !s.deliveryIntent;
    const exhaustedQualityGate =
      s.phase === "blocked" &&
      s.step === "verify" &&
      s.repairs >= 2 &&
      s.error === "Error: Two repair cycles exhausted; human intervention required" &&
      s.findings.some((f) => f.blocking && f.confirmed);
    if (
      !initialPlanner &&
      (!s.worktree ||
        (!s.active && !s.paused && !exhaustedQualityGate) ||
        s.cancelled ||
        s.deliveryIntent)
    ) {
      throw new Error(
        "Uncertain Git/delivery operation needs manual reconciliation; artifacts preserved",
      );
    }
    if (initialPlanner) {
      if (s.repo !== this.git.repo || !this.git.clean() || this.git.head() !== s.baseRevision) {
        throw new Error("Repository changed since planning; inspect and reconcile manually");
      }
    } else {
      this.git.assertOwned(s);
    }
    if (s.paused) {
      this.pauseWanted = false;
    }
    if (initialPlanner) {
      this.cancelWanted = false;
    }
    this.running = true;
    try {
      await this.agents.preflight(s.worktree ?? s.repo);
      this.boundary();
      const snapshot = initialPlanner ? undefined : this.git.snapshot(s);
      if (initialPlanner) {
        if (!this.git.clean() || this.git.head() !== s.baseRevision) {
          throw new Error("Repository changed since planning; inspect and reconcile manually");
        }
        if (!existsSync(join(this.store.dir, s.id + ".json"))) {
          this.store.archive();
        }
        s.cancelled = false;
        this.cancelWanted = false;
      }
      s.approvedRevision = undefined;
      s.approvedDelivery = undefined;
      if (!initialPlanner) {
        s.active = undefined;
      }
      s.paused = false;
      s.pauseSnapshot = undefined;
      s.error = undefined;
      s.step = "implement";
      s.task = 0;
      s.documented = false;
      this.save("planning");
      const plan = validatePlan(
        await this.agent(
          "planner",
          `Recovery: human has inspected the stopped execution and confirmed no child is still running. Existing work must be preserved; do NOT assume interrupted tasks completed. Delegate current checkout inspection to scout and, when useful, web research to researcher, instructing it to call web_enable first. Plan remaining work for request ${s.request}. Propose at least one task, file path and verification command for human approval. Include ALL changed paths since ${s.baseRevision} in the proposed allowed files.`,
        ),
      );
      this.boundary();
      if (
        initialPlanner
          ? !this.git.clean() || this.git.head() !== s.baseRevision
          : this.git.snapshot(s) !== snapshot
      ) {
        throw new Error("Checkout changed during recovery planning");
      }
      s.recoverySnapshot = snapshot;
      s.plans.push(plan);
      if (!initialPlanner) {
        s.planRevision++;
      }
      s.round++;
      this.save("awaiting_approval");
    } catch (e) {
      s.error = String(e);
      if (this.cancelWanted) {
        s.cancelled = true;
        s.paused = true;
      } else if (this.pauseWanted) {
        s.paused = true;
      }
      this.save("blocked");
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
      throw new Error("No approved checkout");
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
    const result = await this.agents.run(
      role,
      task,
      s.worktree ?? s.repo,
      identity,
      this.abort.signal,
    );
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
      `${task}\nApproved plan revision ${s.planRevision}: ${JSON.stringify(this.planValue)}\nStay strictly within approved scope. If scope must change, stop and return scopeChange. Never commit, push, create PRs, change branches/worktrees, alter Git metadata, or weaken verification. Preserve existing changes. Return summary and scopeChange (empty when none).`,
    )) as { summary: string; scopeChange: string };
    if (this.git.head(this.checkout(s)) !== before) {
      s.approvedRevision = undefined;
      s.approvedDelivery = undefined;
      throw new Error("Worker changed Git HEAD; inspect before recovery");
    }
    if (!result || typeof result.summary !== "string" || typeof result.scopeChange !== "string") {
      throw new Error("Invalid worker outcome");
    }
    if (result.scopeChange) {
      s.approvedRevision = undefined;
      s.approvedDelivery = undefined;
      throw new Error("Scope change requires renewed approval: " + result.scopeChange);
    }
    try {
      this.git.scope(s, this.planValue);
    } catch (e) {
      s.approvedRevision = undefined;
      s.approvedDelivery = undefined;
      throw e;
    }
    s.active = { role: "checkpoint", requestId: randomUUID(), started: Date.now() };
    this.save();
    s.revision = this.git.checkpoint(s, this.planValue);
    s.active = undefined;
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
    const result = await execute(c.command, c.args, this.checkout(s), this.abort.signal);
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
      `Independently verify revision ${s.revision}. Run all approved commands: ${JSON.stringify(this.planValue.verification)}. Include build, tests and black-box smoke tests as applicable. Do not edit tracked files/install dependencies or weaken tests. Return passed, summary, commands actually run. Missing verification is a failure.`,
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
    for (const role of ["quality", "security", "ponytail"]) {
      const focus =
        role === "quality"
          ? "architecture, code quality and simplicity"
          : role === "security"
            ? "correctness, security, silent bugs and edge cases"
            : "the installed ponytail-review skill: independently review correctness, safety, load, tests and unnecessary code";
      // oxlint-disable-next-line no-await-in-loop -- Persist each review's active request and evidence before starting the next role.
      const r = (await this.agent(
        role,
        `Independent adversarial READ-ONLY review of ${s.worktree}, exact HEAD ${s.revision}, changes from ${s.baseRevision}. Focus on ${focus}. Read the changed and connected code (not just successful agent responses). Approved plan: ${JSON.stringify(this.planValue)}. Return summary and findings with unique id, blocking boolean and concrete evidence/file paths. No shell or edits.`,
      )) as { summary: string; findings: Finding[] };
      this.git.unchanged(s, this.currentRevision(s));
      validateFindings(r?.findings);
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
    if (!findings.length) {
      s.findings = [];
      this.save();
      return false;
    }
    const result = (await this.agent(
      "triage",
      `READ ONLY consolidate and triage these findings: ${JSON.stringify(findings)}. Confirm suspected defects with concrete source evidence. Reject only with explicit contradictory evidence. Return EVERY original id exactly once, blocking, confirmed boolean, evidence, and optional reproduction executable/argv using ONLY an approved verification command from ${JSON.stringify(this.planValue.verification)}. Test-failure cannot be rejected. No edits or shell.`,
    )) as { findings: Finding[] };
    this.git.unchanged(s, this.currentRevision(s));
    validateFindings(result?.findings);
    if (
      result.findings.length !== findings.length ||
      new Set(result.findings.map((f) => f.id)).size !== findings.length ||
      findings.some((f) => !result.findings.some((r) => r.id === f.id)) ||
      result.findings.some((f) => typeof f.confirmed !== "boolean")
    ) {
      throw new Error("Incomplete triage; gate remains closed");
    }
    for (const f of result.findings) {
      if (f.id === "test-failure") {
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
          throw new Error("Reproduction command needs renewed approval");
        }
        // oxlint-disable-next-line no-await-in-loop -- Persist each reproduction before executing the next finding's command.
        this.evidence("reproduction", { id: f.id, result: await this.command(c) });
      }
    }
    s.findings = result.findings;
    this.evidence("triage", result);
    return s.findings.some((f) => f.confirmed && f.blocking);
  }

  async drive() {
    this.idle();
    const s = this.state;
    if (
      !approvalMatches(s) ||
      s.active ||
      s.cancelled ||
      s.paused ||
      ["completed", "failed", "blocked", "awaiting_approval"].includes(s.phase)
    ) {
      throw new Error("Run is not approved and runnable");
    }
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
        if (!approvalMatches(s)) {
          throw new Error("Approval invalidated");
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
          this.save();
          // oxlint-disable-next-line no-await-in-loop -- Verification must finish before reviews consume its evidence.
          const passed = await this.tests();
          // oxlint-disable-next-line no-await-in-loop -- Reviews follow verification and finish before triage.
          const findings = await this.reviews();
          // oxlint-disable-next-line no-await-in-loop -- Triage depends on completed tester and reviewer evidence.
          if (await this.triage(findings, passed)) {
            if (s.repairs >= 2) {
              throw new Error("Two repair cycles exhausted; human intervention required");
            }
            s.step = "repair";
            this.save();
            continue;
          }
          s.step = s.documented ? "deliver" : "docs";
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
        } else if (s.step === "docs") {
          this.save("documenting");
          // oxlint-disable-next-line no-await-in-loop -- Audit the current revision before any documentation changes.
          const result = (await this.agent(
            "docs",
            `READ ONLY audit docs for revision ${s.revision} against approved request and implementation. Return summary and changes boolean; describe exact needed updates in summary. No edits or shell.`,
          )) as { summary: string; changes: boolean };
          this.git.unchanged(s, this.currentRevision(s));
          if (
            !result ||
            typeof result.changes !== "boolean" ||
            typeof result.summary !== "string"
          ) {
            throw new Error("Invalid documentation audit");
          }
          this.evidence("docs", result);
          if (result.changes) {
            // oxlint-disable-next-line no-await-in-loop -- Checkpoint documentation changes before final verification.
            await this.mutation(
              "worker",
              "Update documentation per independent audit: " + result.summary,
            );
          }
          s.documented = true;
          s.step = "verify";
          this.save();
        } else if (s.step === "deliver") {
          this.save("delivering");
          this.finalGate();
          if (this.cancelWanted || this.pauseWanted) {
            continue;
          }
          const revision = this.currentRevision(s);
          s.deliveryIntent = revision;
          this.save();
          if (!approvalMatches(s)) {
            throw new Error("Approval invalidated");
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
              if (!approvalMatches(s)) {
                throw new Error("Approval invalidated");
              }
              this.git.unchanged(s, revision);
            });
            if (!s.pr.draft || s.pr.head !== s.revision || !s.pr.url.startsWith("https://")) {
              throw new Error("Invalid draft PR receipt");
            }
          }
          s.deliveryIntent = undefined;
          this.save("completed");
          writeFileSync(join(this.store.dir, "report.md"), this.report(), { mode: 0o600 });
          return;
        } else {
          throw new Error("Unknown controller step");
        }
      }
    } catch (e) {
      s.error = String(e);
      if (this.cancelWanted) {
        s.cancelled = true;
        s.paused = true;
      } else if (this.pauseWanted) {
        this.recordPause();
        this.pauseWanted = false;
      }
      this.save("blocked");
    } finally {
      this.running = false;
    }
  }

  private finalGate() {
    const s = this.state;
    this.git.unchanged(s, this.currentRevision(s));
    validateFinalFindings(s);
    if (!s.documented || !approvalMatches(s) || s.findings.some((f) => f.blocking && f.confirmed)) {
      throw new Error("Final quality gate failed");
    }
    const current = s.evidence.filter((e) => e.revision === s.revision && e.round === s.round);
    for (const role of ["tester", "quality", "security", "ponytail"]) {
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
    return `# Pi Software Factory ${s.id}\n\nRequest: ${s.request}\n\nDelivery: ${s.delivery ?? "github"}${s.delivery === "local" ? " (local commits only; no push or PR)" : ""}\nPhase: ${s.phase}${s.paused ? " (paused)" : ""}${s.cancelled ? " (cancelled)" : ""}\nStep: ${s.step}; task ${s.task}/${s.plans.at(-1)?.tasks.length ?? 0}; repairs ${s.repairs}/2\nPlan revision: ${s.planRevision}; approved: ${s.approvedRevision ?? "no"}\nBranch: ${s.branch}\n${s.location === "checkout" ? "Checkout" : "Worktree"}: ${s.worktree ?? "not created"}\nRevision: ${s.revision ?? s.baseRevision}\n${s.delivery === "local" ? `Local receipt: ${s.localReceipt?.revision ?? "not delivered"}` : `PR: ${s.pr?.url ?? "not delivered"}`} \nAgent: ${s.active?.role ?? "none"}\nArtifacts: ${this.store.dir}\n${s.error ?? ""}\n\n## Findings\n${JSON.stringify(s.findings, null, 2)}\n\n## Verification\n${JSON.stringify(s.evidence, null, 2)}\n`;
  }
}

function validateFindings(value: unknown): asserts value is Finding[] {
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
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
