import { execFileSync, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import type { Command, Plan, Run } from './state.ts';

export function execute(command: string, args: string[], cwd: string, signal?: AbortSignal, timeout = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'));
    const child = spawn(command, args, { cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } });
    let stdout = '', stderr = '', stopped = false;
    const stop = () => { stopped = true; try { process.kill(process.platform === 'win32' ? child.pid! : -child.pid!, 'SIGKILL'); } catch {} };
    const timer = setTimeout(stop, timeout); signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', b => { stdout += b; if (stdout.length + stderr.length > 4_000_000) stop(); });
    child.stderr.on('data', b => { stderr += b; if (stdout.length + stderr.length > 4_000_000) stop(); });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', stop); if (stopped) reject(new Error('Command interrupted, timed out, or exceeded 4 MB output')); else done({ code: code ?? 1, stdout, stderr }); });
  });
}
export class Git {
  repo: string;
  constructor(repo: string) { this.repo = realpathSync(this.gitAt(repo, ['rev-parse', '--show-toplevel'])); }
  gitAt(cwd: string, args: string[]) { return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 8_000_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  git(args: string[], cwd = this.repo) { return this.gitAt(cwd, args); }
  stateDir() { return join(resolve(this.repo, this.git(['rev-parse', '--git-common-dir'])), 'pi-factory'); }
  head(cwd = this.repo) { return this.git(['rev-parse', 'HEAD'], cwd); }
  clean(cwd = this.repo) { return this.git(['status', '--porcelain', '--untracked-files=all'], cwd) === ''; }
  create(s: Run, root: string) {
    const path = join(root, 'worktree-' + s.id);
    this.git(['worktree', 'add', '-b', s.branch, path, s.baseRevision]);
    return path;
  }
  assertOwned(s: Run) {
    if (!s.worktree || !s.branch.startsWith('factory/')) throw new Error('Missing factory worktree or feature branch');
    if (this.git(['symbolic-ref', '--short', 'HEAD'], s.worktree) !== s.branch) throw new Error('Worktree branch changed; inspect before continuing');
    if (realpathSync(resolve(s.worktree, this.git(['rev-parse', '--git-common-dir'], s.worktree))) !== realpathSync(resolve(this.repo, this.git(['rev-parse', '--git-common-dir'])))) throw new Error('Worktree belongs to another repository');
  }
  changed(s: Run): string[] {
    const tracked = this.git(['diff', '--no-renames', '--name-only', '-z', s.baseRevision], s.worktree);
    const staged = this.git(['diff', '--cached', '--no-renames', '--name-only', '-z', s.baseRevision], s.worktree);
    const untracked = this.git(['ls-files', '--others', '--exclude-standard', '-z'], s.worktree);
    return [...new Set([...tracked.split('\0'), ...staged.split('\0'), ...untracked.split('\0')].filter(Boolean))];
  }
  scope(s: Run, plan: Plan) {
    this.assertOwned(s);
    const extra = this.changed(s).filter(p => !plan.files.some(f => f.endsWith('/') ? p.startsWith(f) : p === f));
    if (extra.length) throw new Error(`Scope change requires renewed approval: ${extra.join(', ')}`);
  }
  checkpoint(s: Run, plan: Plan) {
    this.scope(s, plan);
    if (!this.clean(s.worktree)) {
      this.git(['add', '--all'], s.worktree);
      this.git(['-c', 'core.hooksPath=/dev/null', 'commit', '-m', `factory: ${plan.summary.slice(0, 120)}`], s.worktree);
    }
    return this.head(s.worktree);
  }
  unchanged(s: Run, revision: string) {
    this.assertOwned(s);
    if (this.head(s.worktree) !== revision || !this.clean(s.worktree)) throw new Error('Verification/review changed the revision or working tree; evidence invalid');
  }
}
export function validatePlan(value: unknown): Plan {
  const p = value as Plan;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 64 && v.every(x => typeof x === 'string' && x.trim() && x.length <= 4000);
  if (!p || typeof p.summary !== 'string' || !p.summary.trim() || p.summary.length > 4000 || !strings(p.tasks) || !p.tasks.length || !strings(p.files) || !p.files.length || !strings(p.risks) || !strings(p.dependencies) || !Array.isArray(p.verification) || !p.verification.length || p.verification.length > 16) throw new Error('Invalid plan: summary, tasks, files, risks, dependencies and verification required');
  for (const file of p.files) {
    const clean = file.replace(/\/$/, '');
    if (!clean || isAbsolute(file) || clean.split('/').some(x => !x || x === '..' || x === '.' || x.toLowerCase() === '.git') || file.includes('\\') || file.includes('\0') || file.startsWith('-')) throw new Error('Invalid approved file path: ' + file);
  }
  p.verification.forEach(validateCommand);
  return p;
}
export function validateCommand(v: unknown): asserts v is Command {
  const c = v as Command;
  if (!c || typeof c.command !== 'string' || !c.command.trim() || c.command.startsWith('-') || c.command.includes('\0') || !Array.isArray(c.args) || c.args.length > 128 || c.args.some(a => typeof a !== 'string' || a.includes('\0') || a.length > 16000) || typeof c.purpose !== 'string' || !c.purpose.trim()) throw new Error('Invalid verification command');
}
export function safeRelative(root: string, path: string) { const r = relative(root, path); return r && !r.startsWith('..') && !isAbsolute(r); }
