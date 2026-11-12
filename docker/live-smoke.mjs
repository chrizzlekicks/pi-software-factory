import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { decodeProbeEvent } from './probe-events.mjs';

if (process.env.PI_SUBAGENT_CHILD === '1') {
  console.error('Live smoke requires a standalone environment, not a pi-subagents child. Run it from a standalone shell.');
  process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), 'pi-factory-live-'));
let child;
try {
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  const probe = join(root, 'probe.ts');
  const agents = pathToFileURL(resolve('src/agents.ts')).href;
  writeFileSync(probe, `
import * as codingAgent from '@earendil-works/pi-coding-agent';
import * as agentCore from '@earendil-works/pi-agent-core';
import * as ai from '@earendil-works/pi-ai';
import * as tui from '@earendil-works/pi-tui';
import * as typebox from 'typebox';
import * as typeboxCompile from 'typebox/compile';
import * as typeboxValue from 'typebox/value';
import { randomUUID } from 'node:crypto';
import { loadSubagents, PiAgents } from ${JSON.stringify(agents)};
export default function(pi) {
  pi.registerCommand('factory-live-probe', { description: 'Read-only factory agent probe', handler: async (_args, ctx) => {
    const report = value => ctx.ui.notify('pi-factory-live:' + JSON.stringify(value), 'info');
    try {
      const api = await loadSubagents({ '@earendil-works/pi-coding-agent': codingAgent, '@earendil-works/pi-agent-core': agentCore, '@earendil-works/pi-ai': ai, '@earendil-works/pi-tui': tui, typebox, 'typebox/compile': typeboxCompile, 'typebox/value': typeboxValue });
      const adapter = new PiAgents(pi, ctx, api, event => { if (event.status === 'completed') report({ probe: 'terminal', event }); });
      await adapter.preflight(ctx.cwd);
      report({ probe: 'preflight', ok: true, parentModel: ctx.model && ctx.model.provider + '/' + ctx.model.id });
      const result = await adapter.run('quality', 'Read only: inspect this empty disposable repository and return a short summary and an empty findings array.', ctx.cwd, { requestId: randomUUID(), ownerRunId: randomUUID(), nodeId: 'live-probe' });
      report({ probe: 'result', result });
    } catch (error) { report({ probe: 'error', error: String(error) }); }
    ctx.shutdown();
  }});
}`);
  child = spawn('pi', ['--mode', 'rpc', '--no-session', '-e', resolve('src/index.ts'), '-e', probe], { cwd: repo, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', result = false, loaded = false, factoryLoaded = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { buffer += chunk; let i; while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); try { const event = JSON.parse(line); if (event.command === 'get_commands') { factoryLoaded = !!event.data?.commands?.some(c => c.name === 'factory' && c.source === 'extension'); console.log(JSON.stringify({ probe: 'factory-load', ok: factoryLoaded })); child.stdin.write(JSON.stringify({ id: 'probe', type: 'prompt', message: '/factory-live-probe' }) + '\n'); } const probe = decodeProbeEvent(event); if (probe || event.type === 'response') console.log(JSON.stringify(probe ?? event)); if (probe?.probe === 'result') result = true; if (probe?.probe === 'preflight' && probe.ok === true) loaded = true; } catch { console.error(line); } } });
  child.stderr.pipe(process.stderr);
  child.stdin.write(JSON.stringify({ id: 'commands', type: 'get_commands' }) + '\n');
  const timer = setTimeout(() => { console.error('Live probe timed out'); try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 180_000);
  const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
  clearTimeout(timer);
  console.log(JSON.stringify({ probe: 'summary', factoryLoaded, preflight: loaded, structuredExecution: result, exitCode: code }));
  if (!factoryLoaded || !loaded || !result || code !== 0) process.exitCode = 1;
} finally {
  if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  rmSync(root, { recursive: true, force: true });
}
