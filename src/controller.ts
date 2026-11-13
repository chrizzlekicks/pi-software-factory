import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { Git, execute, validatePlan } from './git.ts';
import { Store, validateFinalFindings, approvalMatches } from './state.ts';
import type { Run, Phase, Plan, Finding, Command } from './state.ts';

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
  preflight(): Promise<Run['target']>;
  deliver(state: Run, report: string, boundary: () => void): Promise<NonNullable<Run['pr']>>;
}
export class Factory {
  store: Store;
  git: Git;
  agents: Agents;
  delivery: Delivery;
  changed: (s: Run) => void;
  private running = false;
  private abort?: AbortController;
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
    if (!this.store.state) throw new Error('No factory run');
    return this.store.state;
  }
  save(phase?: Phase) {
    if (phase) this.state.phase = phase;
    this.store.save();
    try {
      this.changed(this.state);
    } catch {}
  }
  private idle() {
    if (this.running) throw new Error('Factory controller is busy');
  }
  async plan(request: string, delivery: 'github' | 'local' = 'local') {
    this.idle();
    if (!request.trim()) throw new Error('A development request is required');
    const old = this.store.state;
    if (old?.active || old?.deliveryIntent)
      throw new Error('Prior operation is uncertain; reconcile before starting a new run');
    if (
      old &&
      !['completed', 'failed'].includes(old.phase) &&
      !old.cancelled &&
      old.phase !== 'awaiting_approval'
    )
      throw new Error('Active run exists; inspect or cancel it first');
    if (!this.git.clean())
      throw new Error('Start from a clean repository; user changes are never stashed or discarded');
    this.pauseWanted = false;
    this.cancelWanted = false;
    this.running = true;
    try {
      await this.agents.preflight(this.git.repo);
      if (delivery !== 'github' && delivery !== 'local') throw new Error('Invalid delivery mode');
      if (delivery === 'local') {
        this.git.head();
        for (const key of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) this.git.git(['var', key]);
      }
      const target = delivery === 'github' ? await this.delivery.preflight() : undefined;
      this.boundary();
      this.store.archive();
      const id = randomUUID();
      this.store.state = {
        version: 1,
        location: 'checkout',
        id,
        request,
        repo: this.git.repo,
        baseRevision: this.git.head(),
        phase: 'planning',
        planRevision: 1,
        plans: [],
        branch: 'factory/' + id,
        delivery,
        target,
        step: 'implement',
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
          'planner',
          `Inspect repository READ ONLY. Plan this request: ${request}\nReturn dependencies, risks, exact allowed file paths (directory prefixes end in /), ordered tasks and concrete build/test/black-box verification commands as executable + argv. Include documentation paths. No implementation. Commands and files will require human approval.`,
        ),
      );
      this.boundary();
      if (!this.git.clean() || this.git.head() !== this.state.baseRevision)
        throw new Error('Planner changed repository');
      this.state.plans.push(plan);
      this.save('awaiting_approval');
    } catch (e) {
      if (this.store.state && this.store.state !== old) {
        this.state.error = String(e);
        if (this.cancelWanted) {
          this.state.cancelled = true;
          this.state.paused = true;
        } else if (this.pauseWanted) this.state.paused = true;
        this.save('failed');
      }
      throw e;
    } finally {
      this.running = false;
    }
  }
  reject() {
    this.idle();
    if (this.state.phase !== 'awaiting_approval') throw new Error('No plan awaiting approval');
    this.state.approvedRevision = undefined;
    this.state.approvedDelivery = undefined;
    this.state.cancelled = true;
    this.state.error = 'Plan rejected; submit a revised request';
    this.save('blocked');
  }
  async approve() {
    this.idle();
    const s = this.state;
    if (s.phase !== 'awaiting_approval' || s.cancelled || s.active)
      throw new Error('No current plan awaiting approval');
    validatePlan(s.plans.at(-1));
    if (s.location !== 'checkout')
      throw new Error('Legacy execution location: inspect original worktree and recover manually');
    if (
      s.worktree
        ? !s.recoverySnapshot || this.git.snapshot(s) !== s.recoverySnapshot
        : this.git.head() !== s.baseRevision || !this.git.clean()
    )
      throw new Error('Repository changed since planning; inspect and replan');
    await this.agents.preflight(s.worktree ?? s.repo);
    this.boundary();
    if (s.cancelled || s.paused) throw new Error('Stop requested during approval');
    if (s.worktree) {
      if (this.git.snapshot(s) !== s.recoverySnapshot)
        throw new Error('Checkout changed during approval');
      this.git.scope(s, s.plans.at(-1)!);
    }
    s.approvedRevision = s.planRevision;
    s.approvedDelivery = s.delivery ?? 'github';
    s.delivery ??= 'github';
    s.active = {
      role: s.worktree ? 'checkpoint' : 'branch-create',
      requestId: randomUUID(),
      started: Date.now(),
    };
    this.save('blocked');
    if (!s.worktree) {
      s.worktree = this.git.create(s);
      s.revision = s.baseRevision;
      s.active = undefined;
      this.save();
    } else {
      s.revision = this.git.checkpoint(s, s.plans.at(-1)!);
      s.recoverySnapshot = undefined;
      s.active = undefined;
      this.save();
    }
    s.paused = false;
    s.error = undefined;
    this.save('implementing');
  }
  private recordPause() {
    const s = this.state;
    s.paused = true;
    s.pauseSnapshot = undefined;
    if (s.worktree && !s.active) {
      try {
        s.pauseSnapshot = this.git.snapshot(s);
      } catch (e) {
        s.error = 'Pause snapshot failed; inspected recovery required: ' + String(e);
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
      this.save('blocked');
    }
  }
  async resume() {
    this.idle();
    const s = this.state;
    if (s.active || s.deliveryIntent)
      throw new Error(
        'Uncertain operation: inspect artifacts. Reconcile with the explicit recovery procedure; no automatic replay.',
      );
    if (s.cancelled || ['completed', 'failed'].includes(s.phase))
      throw new Error('Cancelled or terminal run cannot resume');
    if (!approvalMatches(s)) throw new Error('Plan approval required');
    if (s.phase === 'blocked' && !s.paused)
      throw new Error('Quality gate blocked; inspect findings, do not bypass it');
    this.git.unchanged(s, s.revision!);
    if (s.paused && (!s.pauseSnapshot || this.git.snapshot(s) !== s.pauseSnapshot))
      throw new Error('Paused checkout changed or snapshot unavailable; inspect and replan');
    if (['testing', 'reviewing'].includes(s.phase) || s.step === 'deliver') s.step = 'verify';
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
    if (!s.worktree || (!s.active && !s.paused) || s.cancelled || s.deliveryIntent)
      throw new Error(
        'Uncertain Git/delivery operation needs manual reconciliation; artifacts preserved',
      );
    this.git.assertOwned(s);
    if (s.paused) this.pauseWanted = false;
    this.running = true;
    try {
      await this.agents.preflight(s.worktree);
      this.boundary();
      const snapshot = this.git.snapshot(s);
      s.approvedRevision = undefined;
      s.approvedDelivery = undefined;
      s.active = undefined;
      s.paused = false;
      s.pauseSnapshot = undefined;
      s.error = undefined;
      s.step = 'implement';
      s.task = 0;
      s.documented = false;
      this.save('planning');
      const plan = validatePlan(
        await this.agent(
          'planner',
          `Recovery: human has inspected the stopped execution and confirmed no child is still running. Existing work must be preserved; do NOT assume interrupted tasks completed. Inspect current checkout and plan remaining work for request ${s.request}. Include ALL changed paths since ${s.baseRevision} in allowed files and approved verification commands.`,
        ),
      );
      this.boundary();
      if (this.git.snapshot(s) !== snapshot)
        throw new Error('Checkout changed during recovery planning');
      s.recoverySnapshot = snapshot;
      s.plans.push(plan);
      s.planRevision++;
      s.round++;
      this.save('awaiting_approval');
    } catch (e) {
      s.error = String(e);
      if (this.cancelWanted) {
        s.cancelled = true;
        s.paused = true;
      } else if (this.pauseWanted) s.paused = true;
      this.save('blocked');
      throw e;
    } finally {
      this.running = false;
    }
  }
  private get planValue(): Plan {
    return this.state.plans.at(-1)!;
  }
  private boundary() {
    if (this.cancelWanted || this.pauseWanted) throw new Error('Stop requested at safe boundary');
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
    this.git.unchanged(s, s.revision!);
    const before = this.git.head(s.worktree!);
    const result = (await this.agent(
      role,
      `${task}\nApproved plan revision ${s.planRevision}: ${JSON.stringify(this.planValue)}\nStay strictly within approved scope. If scope must change, stop and return scopeChange. Never commit, push, create PRs, change branches/worktrees, alter Git metadata, or weaken verification. Preserve existing changes. Return summary and scopeChange (empty when none).`,
    )) as { summary: string; scopeChange: string };
    if (this.git.head(s.worktree!) !== before) {
      s.approvedRevision = undefined;
      s.approvedDelivery = undefined;
      throw new Error('Worker changed Git HEAD; inspect before recovery');
    }
    if (!result || typeof result.summary !== 'string' || typeof result.scopeChange !== 'string')
      throw new Error('Invalid worker outcome');
    if (result.scopeChange) {
      s.approvedRevision = undefined;
      s.approvedDelivery = undefined;
      throw new Error('Scope change requires renewed approval: ' + result.scopeChange);
    }
    try {
      this.git.scope(s, this.planValue);
    } catch (e) {
      s.approvedRevision = undefined;
      s.approvedDelivery = undefined;
      throw e;
    }
    s.active = { role: 'checkpoint', requestId: randomUUID(), started: Date.now() };
    this.save();
    s.revision = this.git.checkpoint(s, this.planValue);
    s.active = undefined;
    this.save();
  }
  private evidence(role: string, result: unknown) {
    this.state.evidence.push({
      role,
      revision: this.state.revision!,
      round: this.state.round,
      result,
      at: Date.now(),
    });
    this.save();
  }
  private async command(c: Command) {
    this.boundary();
    const s = this.state;
    s.active = { role: 'verification-command', requestId: randomUUID(), started: Date.now() };
    this.save();
    this.abort = new AbortController();
    const result = await execute(c.command, c.args, s.worktree!, this.abort.signal);
    s.active = undefined;
    this.abort = undefined;
    this.git.unchanged(s, s.revision!);
    this.evidence('command', { command: c, ...result });
    return result;
  }
  private async tests() {
    const s = this.state;
    this.save('testing');
    this.git.unchanged(s, s.revision!);
    const result = (await this.agent(
      'tester',
      `Independently verify revision ${s.revision}. Run all approved commands: ${JSON.stringify(this.planValue.verification)}. Include build, tests and black-box smoke tests as applicable. Do not edit tracked files/install dependencies or weaken tests. Return passed, summary, commands actually run. Missing verification is a failure.`,
    )) as { passed: boolean; summary: string; commands: Command[] };
    this.git.unchanged(s, s.revision!);
    if (
      !result ||
      typeof result.passed !== 'boolean' ||
      typeof result.summary !== 'string' ||
      !Array.isArray(result.commands)
    )
      throw new Error('Invalid tester evidence');
    this.evidence('tester', result);
    let passed = result.passed;
    for (const c of this.planValue.verification)
      if ((await this.command(c)).code !== 0) passed = false;
    return passed;
  }
  private async reviews() {
    const s = this.state;
    this.save('reviewing');
    const findings: Finding[] = [];
    for (const role of ['quality', 'security', 'ponytail']) {
      const focus =
        role === 'quality'
          ? 'architecture, code quality and simplicity'
          : role === 'security'
            ? 'correctness, security, silent bugs and edge cases'
            : 'the installed ponytail-review skill: independently review correctness, safety, load, tests and unnecessary code';
      const r = (await this.agent(
        role,
        `Independent adversarial READ-ONLY review of ${s.worktree}, exact HEAD ${s.revision}, changes from ${s.baseRevision}. Focus on ${focus}. Read the changed and connected code (not just successful agent responses). Approved plan: ${JSON.stringify(this.planValue)}. Return summary and findings with unique id, blocking boolean and concrete evidence/file paths. No shell or edits.`,
      )) as { summary: string; findings: Finding[] };
      this.git.unchanged(s, s.revision!);
      validateFindings(r?.findings);
      this.evidence(role, r);
      findings.push(...r.findings.map((f) => ({ ...f, id: role + ':' + f.id })));
    }
    return findings;
  }
  private async triage(findings: Finding[], testsPassed: boolean) {
    const s = this.state;
    if (!testsPassed)
      findings.push({
        id: 'test-failure',
        blocking: true,
        confirmed: true,
        evidence: 'Independent test gate failed',
      });
    if (!findings.length) {
      s.findings = [];
      this.save();
      return false;
    }
    const result = (await this.agent(
      'triage',
      `READ ONLY consolidate and triage these findings: ${JSON.stringify(findings)}. Confirm suspected defects with concrete source evidence. Reject only with explicit contradictory evidence. Return EVERY original id exactly once, blocking, confirmed boolean, evidence, and optional reproduction executable/argv using ONLY an approved verification command from ${JSON.stringify(this.planValue.verification)}. Test-failure cannot be rejected. No edits or shell.`,
    )) as { findings: Finding[] };
    this.git.unchanged(s, s.revision!);
    validateFindings(result?.findings);
    if (
      result.findings.length !== findings.length ||
      new Set(result.findings.map((f) => f.id)).size !== findings.length ||
      findings.some((f) => !result.findings.some((r) => r.id === f.id)) ||
      result.findings.some((f) => typeof f.confirmed !== 'boolean')
    )
      throw new Error('Incomplete triage; gate remains closed');
    for (const f of result.findings) {
      if (f.id === 'test-failure') {
        f.blocking = true;
        f.confirmed = true;
      }
      const original = findings.find((x) => x.id === f.id)!;
      if (original.blocking && f.confirmed) f.blocking = true;
      if (f.reproduction) {
        const c = this.planValue.verification.find(
          (c) =>
            c.command === f.reproduction!.command &&
            JSON.stringify(c.args) === JSON.stringify(f.reproduction!.args),
        );
        if (!c) throw new Error('Reproduction command needs renewed approval');
        this.evidence('reproduction', { id: f.id, result: await this.command(c) });
      }
    }
    s.findings = result.findings;
    this.evidence('triage', result);
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
      ['completed', 'failed', 'blocked', 'awaiting_approval'].includes(s.phase)
    )
      throw new Error('Run is not approved and runnable');
    this.running = true;
    try {
      while (true) {
        if (this.cancelWanted) {
          s.cancelled = true;
          s.paused = true;
          this.save('blocked');
          return;
        }
        if (this.pauseWanted) {
          this.recordPause();
          this.pauseWanted = false;
          this.save();
          return;
        }
        if (!approvalMatches(s)) throw new Error('Approval invalidated');
        this.git.unchanged(s, s.revision!);
        if (s.step === 'implement') {
          this.save('implementing');
          if (s.task < this.planValue.tasks.length) {
            await this.mutation('worker', this.planValue.tasks[s.task]);
            s.task++;
            this.save();
            continue;
          }
          s.step = 'verify';
          this.save();
        } else if (s.step === 'verify') {
          s.round++;
          this.save();
          const passed = await this.tests();
          const findings = await this.reviews();
          if (await this.triage(findings, passed)) {
            if (s.repairs >= 2)
              throw new Error('Two repair cycles exhausted; human intervention required');
            s.step = 'repair';
            this.save();
            continue;
          }
          s.step = s.documented ? 'deliver' : 'docs';
          this.save();
        } else if (s.step === 'repair') {
          this.save('repairing');
          s.repairs++;
          this.save();
          await this.mutation(
            'repair',
            `Repair only confirmed blocking findings: ${JSON.stringify(s.findings)}`,
          );
          s.step = 'verify';
          s.documented = false;
          this.save();
        } else if (s.step === 'docs') {
          this.save('documenting');
          const result = (await this.agent(
            'docs',
            `READ ONLY audit docs for revision ${s.revision} against approved request and implementation. Return summary and changes boolean; describe exact needed updates in summary. No edits or shell.`,
          )) as { summary: string; changes: boolean };
          this.git.unchanged(s, s.revision!);
          if (!result || typeof result.changes !== 'boolean' || typeof result.summary !== 'string')
            throw new Error('Invalid documentation audit');
          this.evidence('docs', result);
          if (result.changes)
            await this.mutation(
              'worker',
              'Update documentation per independent audit: ' + result.summary,
            );
          s.documented = true;
          s.step = 'verify';
          this.save();
        } else if (s.step === 'deliver') {
          this.save('delivering');
          this.finalGate();
          if (this.cancelWanted || this.pauseWanted) continue;
          s.deliveryIntent = s.revision;
          this.save();
          if (!approvalMatches(s)) throw new Error('Approval invalidated');
          if (s.delivery === 'local') {
            this.boundary();
            if (s.pr || s.localReceipt || s.target) throw new Error('Invalid local delivery state');
            this.git.unchanged(s, s.revision!);
            s.localReceipt = { revision: s.revision!, branch: s.branch, worktree: s.worktree! };
          } else {
            s.pr = await this.delivery.deliver(s, this.report(), () => {
              this.boundary();
              if (!approvalMatches(s)) throw new Error('Approval invalidated');
              this.git.unchanged(s, s.revision!);
            });
            if (!s.pr.draft || s.pr.head !== s.revision || !s.pr.url.startsWith('https://'))
              throw new Error('Invalid draft PR receipt');
          }
          s.deliveryIntent = undefined;
          this.save('completed');
          writeFileSync(join(this.store.dir, 'report.md'), this.report(), { mode: 0o600 });
          return;
        } else throw new Error('Unknown controller step');
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
      this.save('blocked');
    } finally {
      this.running = false;
    }
  }
  private finalGate() {
    const s = this.state;
    this.git.unchanged(s, s.revision!);
    validateFinalFindings(s);
    if (!s.documented || !approvalMatches(s) || s.findings.some((f) => f.blocking && f.confirmed))
      throw new Error('Final quality gate failed');
    const current = s.evidence.filter((e) => e.revision === s.revision && e.round === s.round);
    for (const role of ['tester', 'quality', 'security', 'ponytail'])
      if (!current.some((e) => e.role === role)) throw new Error('Missing final evidence: ' + role);
    const commands = current.filter((e) => e.role === 'command');
    if (
      commands.length !== this.planValue.verification.length ||
      commands.some(
        (e, i) =>
          !(e.result as any) ||
          (e.result as any).code !== 0 ||
          JSON.stringify((e.result as any).command) !==
            JSON.stringify(this.planValue.verification[i]),
      ) ||
      !current.some((e) => e.role === 'tester' && (e.result as any)?.passed === true)
    )
      throw new Error('Final verification did not pass');
    for (const role of ['quality', 'security', 'ponytail']) {
      const review = current.find((e) => e.role === role)?.result as any;
      validateFindings(review?.findings);
      if (typeof review.summary !== 'string') throw new Error('Invalid final review');
    }
  }
  report() {
    const s = this.state;
    return `# Pi Software Factory ${s.id}\n\nRequest: ${s.request}\n\nDelivery: ${s.delivery ?? 'github'}${s.delivery === 'local' ? ' (local commits only; no push or PR)' : ''}\nPhase: ${s.phase}${s.paused ? ' (paused)' : ''}${s.cancelled ? ' (cancelled)' : ''}\nStep: ${s.step}; task ${s.task}/${s.plans.at(-1)?.tasks.length ?? 0}; repairs ${s.repairs}/2\nPlan revision: ${s.planRevision}; approved: ${s.approvedRevision ?? 'no'}\nBranch: ${s.branch}\n${s.location === 'checkout' ? 'Checkout' : 'Worktree'}: ${s.worktree ?? 'not created'}\nRevision: ${s.revision ?? s.baseRevision}\n${s.delivery === 'local' ? `Local receipt: ${s.localReceipt?.revision ?? 'not delivered'}` : `PR: ${s.pr?.url ?? 'not delivered'}`} \nAgent: ${s.active?.role ?? 'none'}\nArtifacts: ${this.store.dir}\n${s.error ?? ''}\n\n## Findings\n${JSON.stringify(s.findings, null, 2)}\n\n## Verification\n${JSON.stringify(s.evidence, null, 2)}\n`;
  }
}
function validateFindings(value: unknown): asserts value is Finding[] {
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    value.some(
      (f) =>
        !f ||
        typeof f.id !== 'string' ||
        !f.id.trim() ||
        typeof f.blocking !== 'boolean' ||
        typeof f.evidence !== 'string' ||
        !f.evidence.trim(),
    ) ||
    new Set(value.map((f) => f.id)).size !== value.length
  )
    throw new Error('Invalid review findings');
}
