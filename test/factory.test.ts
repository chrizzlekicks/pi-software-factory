import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Factory } from '../src/controller.ts';
import { Git } from '../src/git.ts';
import { Store } from '../src/state.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
function fixture(t: any, failures = 0) {
  const root = mkdtempSync(join(tmpdir(), 'factory-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  git(root, 'init', '-b', 'main', repo);
  git(repo, 'config', 'user.name', 'Factory Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repo, 'app.txt'), 'old');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'initial');
  const calls: string[] = []; let testRuns = 0; let repairs = 0;
  const plan = { summary: 'Change app', tasks: ['Change app.txt'], files: ['app.txt'], risks: ['None'], dependencies: [], verification: [{ command: process.execPath, args: ['-e', 'process.exit(0)'], purpose: 'Smoke' }] };
  const agents = {
    async preflight() {},
    async run(role: string, task: string, cwd: string) {
      calls.push(role);
      if (role === 'planner') return plan;
      if (role === 'worker') { writeFileSync(join(cwd, 'app.txt'), 'new'); return { summary: 'Done', scopeChange: '' }; }
      if (role === 'repair') { repairs++; writeFileSync(join(cwd, 'app.txt'), 'fixed' + repairs); return { summary: 'Fixed', scopeChange: '' }; }
      if (role === 'tester') return { passed: ++testRuns > failures, summary: 'Tests', commands: plan.verification };
      if (role === 'triage') return { findings: [{ id: 'test-failure', blocking: true, confirmed: true, evidence: 'Reproduced failed tests', reproduction: plan.verification[0] }] };
      if (role === 'docs') return { summary: 'Docs current', changes: false };
      return { summary: 'Clean', findings: [] };
    }
  };
  const delivery = { async preflight() { return { repo: 'example/repo', base: 'main', remote: 'https://github.com/example/repo.git' }; }, async deliver(s: any) { return { url: 'https://github.com/example/repo/pull/1', head: s.revision, draft: true }; } };
  const store = new Store(join(root, 'state'));
  t.after(() => { if (existsSync(store.dir)) store.close(); });
  const factory = new Factory(store, new Git(repo), agents, delivery);
  return { root, repo, factory, store, calls, plan, repairs: () => repairs };
}

test('approval gate, full sequential lifecycle and final revision-bound evidence', async t => {
  const f = fixture(t);
  await f.factory.plan('change app');
  assert.equal(f.store.state?.phase, 'awaiting_approval');
  assert.deepEqual(f.calls, ['planner']);
  assert.equal(readFileSync(join(f.repo, 'app.txt'), 'utf8'), 'old');
  assert.equal(f.store.state?.worktree, undefined);
  await f.factory.approve(); await f.factory.drive();
  const s = f.store.state!;
  assert.equal(s.phase, 'completed'); assert.equal(s.pr?.draft, true);
  assert.ok(s.evidence.length > 0);
  assert.ok(s.evidence.filter(e => e.round === s.round).every(e => e.revision === s.revision));
  assert.equal(readFileSync(join(f.repo, 'app.txt'), 'utf8'), 'old');
  assert.equal(git(s.worktree!, 'status', '--porcelain'), '');
  assert.deepEqual(f.calls, ['planner','worker','tester','quality','security','ponytail','docs','tester','quality','security','ponytail']);
});

test('failures trigger two repairs, then block', async t => {
  const f = fixture(t, 99); await f.factory.plan('change'); await f.factory.approve(); await f.factory.drive();
  assert.equal(f.repairs(), 2); assert.equal(f.store.state?.phase, 'blocked');
  assert.match(f.store.state!.error!, /repair/i);
});

test('one failed test repairs and revalidates', async t => {
  const f = fixture(t, 1); await f.factory.plan('change'); await f.factory.approve(); await f.factory.drive();
  assert.equal(f.repairs(), 1); assert.equal(f.store.state?.phase, 'completed');
});

test('reject, lock and interrupted execution preserve artifacts', async t => {
  const f = fixture(t); await f.factory.plan('change');
  assert.throws(() => new Store(f.store.dir), /writer/i);
  f.factory.reject(); await assert.rejects(f.factory.approve(), /plan/i);
  await f.factory.plan('revised'); await f.factory.approve();
  f.store.state!.active = { role: 'worker', requestId: 'uncertain', started: Date.now() }; f.store.save();
  f.store.close(); const recovered = new Store(f.store.dir); t.after(() => { if (existsSync(recovered.dir)) recovered.close(); });
  assert.equal(recovered.state?.phase, 'blocked'); assert.ok(recovered.state?.active);
  const factory = new Factory(recovered, new Git(f.repo), {} as any, {} as any);
  await assert.rejects(factory.resume(), /uncertain/i);
  assert.ok(existsSync(recovered.state!.worktree!));
});

test('scope escape blocks delivery and revokes approval', async t => {
  const f = fixture(t);
  (f.factory.agents as any).run = async (role: string, task: string, cwd: string) => {
    if (role === 'planner') return f.plan;
    writeFileSync(join(cwd, 'unapproved.txt'), 'escape'); return { summary: 'done', scopeChange: '' };
  };
  await f.factory.plan('change'); await f.factory.approve(); await f.factory.drive();
  assert.equal(f.store.state?.phase, 'blocked'); assert.equal(f.store.state?.approvedRevision, undefined);
  assert.ok(existsSync(join(f.store.state!.worktree!, 'unapproved.txt')));
});

test('pause and resume preserve the approval gate', async t => {
  const f = fixture(t); await f.factory.plan('change');
  await assert.rejects(f.factory.drive(), /approved/);
  await f.factory.approve(); f.factory.pause();
  await assert.rejects(f.factory.drive(), /runnable/);
  await f.factory.resume(); await f.factory.drive();
  assert.equal(f.store.state!.phase, 'completed');
});

test('approved command failure blocks delivery even if tester claims success', async t => {
  const f = fixture(t); f.plan.verification[0].args = ['-e', 'process.exit(1)'];
  await f.factory.plan('change'); await f.factory.approve(); await f.factory.drive();
  assert.equal(f.store.state!.phase, 'blocked'); assert.equal(f.store.state!.pr, undefined);
  assert.equal(f.repairs(), 2);
});

test('documentation mutation is reverified at its new revision', async t => {
  const f = fixture(t); f.plan.files.push('docs.txt');
  const run = f.factory.agents.run.bind(f.factory.agents); let docs = false;
  f.factory.agents.run = async (role, task, cwd, identity, signal) => {
    if (role === 'docs') { docs = true; return { summary: 'Update docs', changes: true }; }
    if (role === 'worker' && docs) { writeFileSync(join(cwd, 'docs.txt'), 'new docs'); return { summary: 'docs', scopeChange: '' }; }
    return run(role, task, cwd, identity, signal);
  };
  await f.factory.plan('change'); await f.factory.approve(); await f.factory.drive();
  const s = f.store.state!; assert.equal(s.phase, 'completed');
  assert.notEqual(s.evidence.find(e => e.role === 'docs')!.revision, s.revision);
  assert.ok(s.evidence.some(e => e.role === 'tester' && e.revision === s.revision));
});

test('worker commit and staged unapproved changes block and preserve artifacts', async t => {
  const f = fixture(t); const run = f.factory.agents.run.bind(f.factory.agents);
  f.factory.agents.run = async (role, task, cwd, identity, signal) => {
    if (role !== 'worker') return run(role, task, cwd, identity, signal);
    writeFileSync(join(cwd, 'app.txt'), 'committed'); git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'unauthorized');
    return { summary: 'committed', scopeChange: '' };
  };
  await f.factory.plan('change'); await f.factory.approve(); await f.factory.drive();
  assert.equal(f.store.state!.phase, 'blocked'); assert.equal(f.store.state!.approvedRevision, undefined);
  assert.match(f.store.state!.error!, /HEAD/); assert.equal(f.store.state!.pr, undefined);
});

test('delivery uncertainty is preserved and cannot be resumed', async t => {
  const f = fixture(t); f.factory.delivery.deliver = async () => { throw new Error('uncertain push'); };
  await f.factory.plan('change'); await f.factory.approve(); await f.factory.drive();
  assert.equal(f.store.state!.phase, 'blocked'); assert.ok(f.store.state!.deliveryIntent);
  await assert.rejects(f.factory.resume(), /uncertain/i);
});

test('recovery requires a new approval', async t => {
  const f = fixture(t); await f.factory.plan('change'); await f.factory.approve();
  f.store.state!.active = { role: 'worker', requestId: 'stopped', started: Date.now() }; f.store.save();
  await f.factory.replanAfterInterruption();
  assert.equal(f.store.state!.phase, 'awaiting_approval'); assert.equal(f.store.state!.approvedRevision, undefined);
  await assert.rejects(f.factory.drive(), /approved/);
  await f.factory.approve(); await f.factory.drive(); assert.equal(f.store.state!.phase, 'completed');
});

test('GitHub delivery uses fake gh and a disposable local remote', async t => {
  const { mkdirSync, chmodSync } = await import('node:fs');
  const { GitHubDelivery } = await import('../src/delivery.ts');
  const f = fixture(t); const bare = join(f.root, 'remote.git');
  git(f.root, 'init', '--bare', bare);
  git(f.repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git');
  const bin = join(f.root, 'bin'); mkdirSync(bin);
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!${process.execPath}\nconst a=process.argv.slice(2);\nif(a[0]==='auth') console.log('ok');\nelse if(a[0]==='repo') console.log(JSON.stringify({nameWithOwner:'example/repo',defaultBranchRef:{name:'main'},isArchived:false,viewerPermission:'WRITE'}));\nelse if(a[0]==='api' && a[1].includes('/rules/')) console.log('[]');\nelse if(a[0]==='api') console.log(JSON.stringify({commit:{sha:process.env.TEST_BASE}}));\nelse if(a[0]==='pr' && a[1]==='list') console.log('[]');\nelse if(a[0]==='pr' && a[1]==='create') console.log('https://github.com/example/repo/pull/1');\nelse if(a[0]==='pr' && a[1]==='view') {const cp=require('node:child_process'); const refs=cp.execFileSync('git',['--git-dir',process.env.TEST_BARE,'for-each-ref','--format=%(refname:short) %(objectname)','refs/heads/factory/'],{encoding:'utf8'}).trim().split(' '); console.log(JSON.stringify({url:'https://github.com/example/repo/pull/1',isDraft:true,headRefName:refs[0],headRefOid:refs[1],baseRefName:'main'}));} else process.exit(1);\n`); chmodSync(gh, 0o755);
  const old = { PATH: process.env.PATH, TEST_BASE: process.env.TEST_BASE, TEST_BARE: process.env.TEST_BARE };
  t.after(() => { for (const [k,v] of Object.entries(old)) v === undefined ? delete process.env[k] : process.env[k] = v; });
  process.env.PATH = bin + ':' + old.PATH; process.env.TEST_BASE = git(f.repo, 'rev-parse', 'HEAD'); process.env.TEST_BARE = bare;
  f.factory.delivery = new GitHubDelivery(f.factory.git, f.store.dir);
  await f.factory.plan('change');
  git(f.repo, 'config', `url.${bare}.insteadOf`, 'https://github.com/example/repo.git');
  await f.factory.approve(); await f.factory.drive();
  assert.equal(f.store.state!.phase, 'completed', f.store.state!.error);
  assert.equal(git(f.root, '--git-dir', bare, 'rev-parse', `refs/heads/${f.store.state!.branch}`), f.store.state!.revision);
});

test('uncertain and cancelled runs cannot be replaced or recovered', async t => {
  const f = fixture(t); await f.factory.plan('change'); await f.factory.approve();
  const s = f.store.state!; s.active = { role: 'worker', requestId: 'uncertain', started: Date.now() }; s.cancelled = true; s.phase = 'blocked'; f.store.save();
  await assert.rejects(f.factory.plan('another'), /uncertain/);
  await assert.rejects(f.factory.replanAfterInterruption(), /uncertain/i);
  assert.equal(s.active.requestId, 'uncertain');
});

test('recovery preserves repair count and rejects quality blocks', async t => {
  const f = fixture(t); await f.factory.plan('change'); await f.factory.approve();
  const s = f.store.state!; s.phase = 'blocked'; s.repairs = 2; f.store.save();
  await assert.rejects(f.factory.replanAfterInterruption(), /uncertain/i);
  s.active = { role: 'worker', requestId: 'uncertain', started: Date.now() }; f.store.save();
  await f.factory.replanAfterInterruption(); assert.equal(s.repairs, 2);
});

test('invalid persisted gate fields fail closed without modifying the file', async t => {
  const f = fixture(t); await f.factory.plan('change'); f.store.close();
  const path = join(f.store.dir, 'state.json'); const s = JSON.parse(readFileSync(path, 'utf8')); s.repairs = -1;
  const invalid = JSON.stringify(s); writeFileSync(path, invalid);
  assert.throws(() => new Store(f.store.dir), /invalid/i); assert.equal(readFileSync(path, 'utf8'), invalid);
});

test('pause after tester prevents approved commands and reviewers', async t => {
  const f = fixture(t); await f.factory.plan('change'); await f.factory.approve();
  const run = f.factory.agents.run.bind(f.factory.agents);
  f.factory.agents.run = async (...args) => { const result = await run(...args); if (args[0] === 'tester') f.factory.pause(); return result; };
  await f.factory.drive(); assert.equal(f.store.state!.paused, true); assert.equal(f.calls.includes('quality'), false); assert.equal(f.store.state!.evidence.some(e => e.role === 'command'), false);
});

test('approval interruption during preflight prevents worktree creation', async t => {
  const f = fixture(t); await f.factory.plan('change');
  f.factory.agents.preflight = async () => { f.factory.cancel(); };
  await assert.rejects(f.factory.approve(), /stop/i);
  assert.equal(f.store.state!.cancelled, true); assert.equal(f.store.state!.worktree, undefined);
});

test('invalid persisted evidence is rejected without rewriting the state', async t => {
  const f = fixture(t); await f.factory.plan('change'); await f.factory.approve(); await f.factory.drive(); f.store.close();
  const path = join(f.store.dir, 'state.json'); const s = JSON.parse(readFileSync(path, 'utf8'));
  s.evidence.find((e: any) => e.role === 'tester').result = { passed: true };
  const invalid = JSON.stringify(s); writeFileSync(path, invalid);
  assert.throws(() => new Store(f.store.dir), /invalid/i); assert.equal(readFileSync(path, 'utf8'), invalid);
});

test('restart blocks a nonterminal boundary even without an active child', async t => {
  const f = fixture(t); await f.factory.plan('change'); await f.factory.approve();
  f.store.close(); const reopened = new Store(f.store.dir);
  try {
    assert.equal(reopened.state!.phase, 'blocked');
    assert.match(reopened.state!.error!, /Interrupted/);
  } finally { reopened.close(); }
});

test('persisted delivery evidence must match approved commands', async t => {
  const f = fixture(t); await f.factory.plan('change'); await f.factory.approve(); await f.factory.drive();
  const state = f.store.state!;
  assert.equal(state.phase, 'completed');
  const command = state.evidence.find(e => e.role === 'command' && e.round === state.round)!;
  (command.result as any).command = { ...(command.result as any).command, args: ['-e', 'process.exit(1)'] };
  f.store.save(); f.store.close();
  assert.throws(() => new Store(f.store.dir), /Invalid factory state/);
});

test('command dispatch gates planning, concurrent approval and shutdown', async t => {
  const { registerFactoryCommands } = await import('../src/commands.ts');
  const f = fixture(t); let handler: any, shutdown: any; const notices: string[] = [];
  const pi = { registerCommand(_name: string, command: any) { handler = command.handler; }, on(_event: string, cb: any) { shutdown = cb; } };
  const ctx = { ui: { notify(message: string) { notices.push(message); } } };
  registerFactoryCommands(pi as any, async () => f.factory, () => f.store.close());
  await handler('request change app', ctx);
  assert.deepEqual(f.calls, ['planner']); assert.equal(f.store.state!.phase, 'awaiting_approval');
  let release!: () => void; const waiting = new Promise<void>(r => { release = r; });
  f.factory.agents.preflight = async () => waiting;
  const first = handler('approve', ctx); await handler('approve', ctx);
  assert.ok(notices.some(n => /already in progress/.test(n)));
  const stopping = shutdown();
  await Promise.resolve(); assert.throws(() => new Store(f.store.dir), /writer/);
  release(); await first; await stopping;
  const reopened = new Store(f.store.dir); reopened.close();
});

test('command pause and cancel interrupt planning without approval', async t => {
  const { registerFactoryCommands } = await import('../src/commands.ts');
  for (const action of ['pause', 'cancel']) {
    const f = fixture(t); let handler: any; let release!: () => void;
    const started = new Promise<void>(resolve => { f.factory.agents.run = async () => { resolve(); await new Promise<void>(r => { release = r; }); return f.plan; }; });
    const pi = { registerCommand(_name: string, command: any) { handler = command.handler; }, on() {} };
    const ctx = { ui: { notify() {} } };
    registerFactoryCommands(pi as any, async () => f.factory, () => f.store.close());
    const request = handler('request change', ctx); await started;
    await handler(action, ctx); release(); await request;
    assert.equal(f.store.state!.approvedRevision, undefined); assert.equal(f.store.state!.phase, 'failed');
    assert.equal(f.store.state!.paused, true); assert.equal(f.store.state!.cancelled, action === 'cancel');
  }
});

test('concurrent commands share initialization and deny a duplicate request', async t => {
  const { registerFactoryCommands } = await import('../src/commands.ts');
  const f = fixture(t); let handler: any, release!: () => void, calls = 0; const notices: string[] = [];
  const gate = new Promise<void>(r => { release = r; });
  const pi = { registerCommand(_name: string, command: any) { handler = command.handler; }, on() {} };
  const ctx = { ui: { notify(message: string) { notices.push(message); } } };
  registerFactoryCommands(pi as any, async () => { calls++; await gate; return f.factory; }, () => f.store.close());
  const first = handler('request first', ctx); await handler('request second', ctx);
  const status = handler('status', ctx); release(); await Promise.all([first, status]);
  assert.equal(calls, 1); assert.ok(notices.some(n => /already in progress/.test(n)));
  assert.equal(f.store.state!.request, 'first');
});

test('persisted delivery state rejects inconsistent task or documentation', async t => {
  for (const corrupt of [(s: any) => { s.task = 0; }, (s: any) => { s.documented = false; }, (s: any) => { s.approvedRevision = undefined; }]) {
    const f = fixture(t); await f.factory.plan('change'); await f.factory.approve(); await f.factory.drive();
    corrupt(f.store.state); f.store.save(); f.store.close();
    assert.throws(() => new Store(f.store.dir), /Invalid factory state/);
  }
});

test('cancellation during recovery planning persists across restart', async t => {
  const f = fixture(t); await f.factory.plan('change'); await f.factory.approve();
  f.store.state!.active = { role: 'worker', requestId: 'stopped', started: Date.now() }; f.store.save();
  let started!: () => void, release!: () => void;
  const waiting = new Promise<void>(r => { started = r; });
  const gate = new Promise<void>(r => { release = r; });
  f.factory.agents.run = async () => { started(); await gate; return f.plan; };
  const recovery = f.factory.replanAfterInterruption(); await waiting; f.factory.cancel(); release();
  await assert.rejects(recovery, /stop/i); f.store.close();
  const reopened = new Store(f.store.dir);
  try { assert.equal(reopened.state!.cancelled, true); assert.equal(reopened.state!.phase, 'blocked'); await assert.rejects(new Factory(reopened, new Git(f.repo), f.factory.agents, f.factory.delivery).approve(), /plan/i); }
  finally { reopened.close(); }
});

test('final review findings require exact triage and persisted findings', async t => {
  const f = fixture(t); const run = f.factory.agents.run.bind(f.factory.agents);
  f.factory.agents.run = async (...args) => {
    if (args[0] === 'quality') return { summary: 'Review', findings: [{ id: 'suspect', blocking: true, evidence: 'Suspected defect' }] };
    if (args[0] === 'triage') return { findings: [{ id: 'quality:suspect', blocking: true, confirmed: false, evidence: 'Contradicted by source' }] };
    return run(...args);
  };
  await f.factory.plan('change'); await f.factory.approve(); await f.factory.drive();
  assert.equal(f.store.state!.phase, 'completed', f.store.state!.error);
  f.store.close(); const path = join(f.store.dir, 'state.json'); const valid = JSON.parse(readFileSync(path, 'utf8'));
  const reopened = new Store(f.store.dir); reopened.close();
  for (const corrupt of [
    (s: any) => { s.findings = []; },
    (s: any) => { s.evidence.find((e: any) => e.round === s.round && e.role === 'triage').result.findings[0].confirmed = true; },
    (s: any) => { s.evidence.find((e: any) => e.round === s.round && e.role === 'triage').result.findings = [{}]; },
    (s: any) => { s.evidence = s.evidence.filter((e: any) => !(e.round === s.round && e.role === 'triage')); s.findings = []; },
  ]) {
    const s = structuredClone(valid); corrupt(s); const invalid = JSON.stringify(s); writeFileSync(path, invalid);
    assert.throws(() => new Store(f.store.dir), /invalid/i); assert.equal(readFileSync(path, 'utf8'), invalid);
  }
});

test('final gate rejects current review blockers absent from findings', async t => {
  const f = fixture(t); const deliver = f.factory.delivery.deliver;
  f.factory.delivery.deliver = async (...args) => deliver(...args);
  await f.factory.plan('change'); await f.factory.approve();
  const run = f.factory.agents.run.bind(f.factory.agents);
  f.factory.agents.run = async (...args) => {
    const result = await run(...args);
    if (args[0] === 'ponytail' && f.store.state!.documented) {
      const quality = f.store.state!.evidence.find(e => e.role === 'quality' && e.round === f.store.state!.round)!;
      (quality.result as any).findings.push({ id: 'hidden', blocking: true, evidence: 'Hidden blocker' });
    }
    return result;
  };
  await f.factory.drive(); assert.equal(f.store.state!.phase, 'blocked'); assert.equal(f.store.state!.pr, undefined);
});
