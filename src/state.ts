import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, fsyncSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validatePlan, validateCommand } from './git.ts';

export type Phase = 'planning' | 'awaiting_approval' | 'implementing' | 'testing' | 'reviewing' | 'repairing' | 'documenting' | 'delivering' | 'completed' | 'blocked' | 'failed';
export type Command = { command: string; args: string[]; purpose: string };
export type Plan = { summary: string; tasks: string[]; files: string[]; risks: string[]; dependencies: string[]; verification: Command[] };
export type Finding = { id: string; blocking: boolean; confirmed?: boolean; evidence: string; reproduction?: Command };
export type Evidence = { role: string; revision: string; round: number; result: unknown; at: number };
export type Run = {
  version: 1; id: string; request: string; repo: string; baseRevision: string; phase: Phase;
  planRevision: number; plans: Plan[]; approvedRevision?: number; branch: string; worktree?: string;
  target: { repo: string; base: string; remote: string }; step: string; task: number; repairs: number; round: number;
  documented: boolean; paused: boolean; cancelled: boolean; revision?: string; error?: string;
  active?: { role: string; requestId: string; started: number }; executions: Evidence[]; evidence: Evidence[]; findings: Finding[];
  pr?: { url: string; head: string; draft: boolean }; deliveryIntent?: string; updated: number;
};
export function validateFinalFindings(s: Run) {
  const fail = () => { throw new Error('Invalid final findings'); };
  const current = s.evidence.filter(e => e.round === s.round && e.revision === s.revision);
  const originals: Finding[] = [];
  for (const role of ['quality', 'security', 'ponytail']) {
    const reviews = current.filter(e => e.role === role);
    if (reviews.length !== 1 || !Array.isArray((reviews[0].result as any)?.findings)) fail();
    for (const f of (reviews[0].result as any).findings) originals.push({ ...f, id: role + ':' + f.id });
  }
  if (current.some(e => e.role === 'tester' && (e.result as any)?.passed === false) || current.some(e => e.role === 'command' && (e.result as any)?.code !== 0)) originals.push({ id: 'test-failure', blocking: true, confirmed: true, evidence: 'Independent test gate failed' });
  if (new Set(originals.map(f => f.id)).size !== originals.length) fail();
  const triages = current.filter(e => e.role === 'triage');
  if (!originals.length) { if (triages.length || s.findings.length) fail(); return; }
  if (triages.length !== 1) fail();
  const findings = (triages[0].result as any)?.findings;
  if (!Array.isArray(findings) || findings.length !== originals.length || new Set(findings.map((f: Finding) => f?.id)).size !== originals.length || s.findings.length !== findings.length) fail();
  for (const original of originals) {
    const f = findings.find((x: Finding) => x.id === original.id);
    const saved = s.findings.find(x => x.id === original.id);
    if (!f || !saved || typeof f.confirmed !== 'boolean' || (original.id === 'test-failure' && (!f.confirmed || !f.blocking)) || (original.blocking && f.confirmed && !f.blocking) || (f.confirmed && f.blocking) || f.blocking !== saved.blocking || f.confirmed !== saved.confirmed || f.evidence !== saved.evidence || JSON.stringify(f.reproduction) !== JSON.stringify(saved.reproduction)) fail();
  }
}
function validateRun(s: any): asserts s is Run {
  const text = (x: unknown) => typeof x === 'string' && x.length > 0;
  const integer = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0;
  const optionalText = (x: unknown) => x === undefined || text(x);
  const fail = () => { throw new Error('Invalid factory state'); };
  if (!s || typeof s !== 'object' || s.version !== 1 || !text(s.id) || !/^[0-9a-f-]{36}$/.test(s.id) || !text(s.request) || !text(s.repo) || !text(s.baseRevision) || s.branch !== 'factory/' + s.id || !['planning','awaiting_approval','implementing','testing','reviewing','repairing','documenting','delivering','completed','blocked','failed'].includes(s.phase) || !['implement','verify','repair','docs','deliver'].includes(s.step)) fail();
  if (!s.target || !text(s.target.repo) || !text(s.target.base) || !text(s.target.remote) || !integer(s.planRevision) || s.planRevision < 1 || !Array.isArray(s.plans) || s.plans.length > s.planRevision || s.plans.length < s.planRevision - 1) fail();
  for (const plan of s.plans) validatePlan(plan);
  if (s.approvedRevision !== undefined && (s.approvedRevision !== s.planRevision || s.plans.length !== s.planRevision)) fail();
  if (!integer(s.task) || !integer(s.repairs) || s.repairs > 2 || !integer(s.round) || !integer(s.updated) || !['documented','paused','cancelled'].every(k => typeof s[k] === 'boolean') || !optionalText(s.worktree) || !optionalText(s.revision) || !optionalText(s.error) || !optionalText(s.deliveryIntent)) fail();
  if (s.plans.length && s.task > s.plans.at(-1).tasks.length) fail();
  if (s.active && (!text(s.active.role) || !text(s.active.requestId) || !integer(s.active.started))) fail();
  if (s.deliveryIntent && (!s.worktree || !s.revision || s.deliveryIntent !== s.revision)) fail();
  if (s.pr && (!text(s.pr.url) || !text(s.pr.head) || typeof s.pr.draft !== 'boolean')) fail();
  if (s.phase === 'completed' && (!s.pr?.draft || s.pr.head !== s.revision || s.deliveryIntent)) fail();
  if (s.phase === 'awaiting_approval' && (s.plans.length !== s.planRevision || s.approvedRevision !== undefined)) fail();
  if (s.step !== 'implement' && s.plans.length && s.task !== s.plans.at(-1).tasks.length) fail();
  if (s.step === 'deliver' && (!s.documented || !s.revision || s.approvedRevision !== s.planRevision)) fail();
  if (s.documented && !s.revision) fail();
  if (['implementing','testing','reviewing','repairing','documenting','delivering','completed'].includes(s.phase) && (!s.worktree || s.approvedRevision !== s.planRevision)) fail();
  if (!Array.isArray(s.findings) || s.findings.some((f: any) => !f || !text(f.id) || typeof f.blocking !== 'boolean' || !text(f.evidence) || (f.confirmed !== undefined && typeof f.confirmed !== 'boolean'))) fail();
  for (const f of s.findings) if (f.reproduction !== undefined) validateCommand(f.reproduction);
  for (const list of [s.executions, s.evidence]) if (!Array.isArray(list) || list.some((e: any) => !e || !text(e.role) || !text(e.revision) || !integer(e.round) || e.round > s.round || !integer(e.at) || !Object.hasOwn(e, 'result'))) fail();
  for (const e of s.evidence) {
    const r = e.result;
    if (!r || typeof r !== 'object') fail();
    if (e.role === 'command') { validateCommand(r.command); if (!Number.isInteger(r.code) || typeof r.stdout !== 'string' || typeof r.stderr !== 'string') fail(); }
    else if (e.role === 'tester') { if (typeof r.passed !== 'boolean' || typeof r.summary !== 'string' || !Array.isArray(r.commands)) fail(); for (const c of r.commands) validateCommand(c); }
    else if (['quality','security','ponytail'].includes(e.role)) { if (typeof r.summary !== 'string' || !Array.isArray(r.findings) || r.findings.some((f: any) => !f || !text(f.id) || typeof f.blocking !== 'boolean' || !text(f.evidence))) fail(); }
    else if (e.role === 'triage') { if (!Array.isArray(r.findings) || r.findings.some((f: any) => !f || !text(f.id) || typeof f.blocking !== 'boolean' || typeof f.confirmed !== 'boolean' || !text(f.evidence)) || new Set(r.findings.map((f: any) => f.id)).size !== r.findings.length) fail(); for (const f of r.findings) if (f.reproduction !== undefined) validateCommand(f.reproduction); }
    else if (e.role === 'docs') { if (typeof r.summary !== 'string' || typeof r.changes !== 'boolean') fail(); }
    else if (e.role === 'reproduction') { if (!text(r.id) || !r.result || !Number.isInteger(r.result.code) || typeof r.result.stdout !== 'string' || typeof r.result.stderr !== 'string') fail(); }
    else fail();
  }

  if (s.step === 'deliver') {
    validateFinalFindings(s);
    const current = s.evidence.filter((e: Evidence) => e.round === s.round && e.revision === s.revision);
    const commands = current.filter((e: Evidence) => e.role === 'command');
    const expected = s.plans.at(-1).verification;
    if (commands.length !== expected.length || commands.some((e: Evidence, i: number) => (e.result as any).code !== 0 || JSON.stringify((e.result as any).command) !== JSON.stringify(expected[i])) || !current.some((e: Evidence) => e.role === 'tester' && (e.result as any).passed === true) || ['quality', 'security', 'ponytail'].some(role => !current.some((e: Evidence) => e.role === role))) fail();
  }

}
export function atomic(path: string, value: unknown) {
  const temp = path + '.' + randomUUID() + '.tmp';
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
}
export class Store {
  dir: string; state?: Run; private lock: number | undefined;
  constructor(dir: string) {
    this.dir = dir; mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lockPath = join(dir, 'writer.lock');
    // A dead PID is insufficient proof that a child has stopped. Never steal a lock.
    try { this.lock = openSync(lockPath, 'wx', 0o600); } catch { throw new Error(`Factory writer lock exists: ${lockPath}. Inspect owner and child termination before removing it.`); }
    writeFileSync(this.lock, JSON.stringify({ pid: process.pid, started: Date.now() }));
    try {
      const path = join(dir, 'state.json');
      if (existsSync(path)) {
        this.state = JSON.parse(readFileSync(path, 'utf8'));
        validateRun(this.state);
        if (this.state.active || this.state.deliveryIntent || (!this.state.paused && !this.state.cancelled && !['awaiting_approval', 'completed', 'failed', 'blocked'].includes(this.state.phase))) {
          this.state.phase = 'blocked'; this.state.error = 'Interrupted operation is uncertain; inspect artifacts and reconcile before resuming.'; this.save();
        }
      }
    } catch (e) { this.close(); throw e; }
  }
  save() {
    if (this.lock === undefined) throw new Error('Store is closed');
    if (!this.state) return;
    this.state.updated = Date.now(); atomic(join(this.dir, 'state.json'), this.state);
  }
  archive() { if (this.state) atomic(join(this.dir, this.state.id + '.json'), this.state); }
  close() {
    if (this.lock === undefined) return;
    closeSync(this.lock); this.lock = undefined; unlinkSync(join(this.dir, 'writer.lock'));
  }
}
