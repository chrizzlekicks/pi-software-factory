import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Agents } from './controller.ts';

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const text = { type: 'string' }, flag = { type: 'boolean' };
const texts = { type: 'array', items: text, maxItems: 64 };
const command = object({ command: text, args: texts, purpose: text });
const finding = object({ id: text, blocking: flag, evidence: text, confirmed: flag, reproduction: command }, ['id','blocking','evidence']);
const findings = { type: 'array', items: finding, maxItems: 64 };
export const roles: Record<string, { agent: string; readOnly: boolean; schema: unknown; skill?: string }> = {
  planner: { agent: 'scout', readOnly: true, schema: object({ summary: text, tasks: texts, files: texts, risks: texts, dependencies: texts, verification: { type: 'array', items: command, maxItems: 16 } }) },
  worker: { agent: 'worker', readOnly: false, schema: object({ summary: text, scopeChange: text }) },
  repair: { agent: 'worker', readOnly: false, schema: object({ summary: text, scopeChange: text }) },
  tester: { agent: 'test-runner', readOnly: false, schema: object({ passed: flag, summary: text, commands: { type: 'array', items: command } }) },
  quality: { agent: 'reviewer', readOnly: true, schema: object({ summary: text, findings }) },
  security: { agent: 'reviewer', readOnly: true, schema: object({ summary: text, findings }) },
  ponytail: { agent: 'reviewer', readOnly: true, skill: 'ponytail-review', schema: object({ summary: text, findings }) },
  triage: { agent: 'reviewer', readOnly: true, schema: object({ findings }) },
  docs: { agent: 'docs-auditor', readOnly: true, schema: object({ summary: text, changes: flag }) },
};
export async function loadSubagents(hostModules: Record<string, unknown>) {
  const require = createRequire(import.meta.url);
  let packagePath: string;
  try { packagePath = require.resolve('pi-subagents/package.json'); }
  catch {
    const root = process.env.PI_FACTORY_SUBAGENTS_PATH ?? join(homedir(), '.pi', 'agent', 'npm', 'node_modules', 'pi-subagents');
    packagePath = join(root, 'package.json');
  }
  const ownerRequire = createRequire(packagePath);
  const { createJiti } = ownerRequire('jiti');
  const jiti = createJiti(import.meta.url, { virtualModules: hostModules, tryNative: false });
  const load = async (name: string) => jiti.import(ownerRequire.resolve('pi-subagents/' + name));
  try { return { delegation: await load('delegation'), ceiling: await load('capability-ceiling'), preflight: await load('preflight') }; }
  catch (e) { throw new Error('Compatible pi-subagents installation unavailable; set PI_FACTORY_SUBAGENTS_PATH to its package directory. ' + String(e)); }
}
export class PiAgents implements Agents {
  pi: ExtensionAPI; ctx: ExtensionContext; api: Awaited<ReturnType<typeof loadSubagents>>;
  progress: (update: unknown) => void;
  constructor(pi: ExtensionAPI, ctx: ExtensionContext, api: Awaited<ReturnType<typeof loadSubagents>>, progress = (_: unknown) => {}) { this.pi = pi; this.ctx = ctx; this.api = api; this.progress = progress; }
  private ceiling(role: string) {
    const r = roles[role]; if (!r) throw new Error('Unknown factory role');
    return this.api.ceiling.registerSubagentCapabilityCeiling({ sessionId: this.ctx.sessionManager.getSessionId(), source: 'pi-factory:' + role, ceiling: { allowedAgents: [r.agent], allowedTools: r.readOnly ? ['read','grep','find','ls'] : role === 'tester' ? ['read','bash'] : ['read','grep','find','ls','bash','edit','write'], denyExtensions: true } });
  }
  private async contract(role: string, cwd: string) {
    const r = roles[role];
    const result = await this.api.preflight.resolveSubagentLaunchContract({
      agent: r.agent, task: 'Factory preflight', cwd, context: 'fresh', skill: r.skill, outputSchema: r.schema,
      parentModel: this.ctx.model, projectTrusted: this.ctx.isProjectTrusted(),
      availableModels: this.ctx.modelRegistry.getAvailable(), knownProviders: () => this.ctx.modelRegistry.getAll().map(m => m.provider),
      scopedModelIds: this.ctx.scopedModels.map(m => `${m.model.provider}/${m.model.id}`),
      parentSessionId: this.ctx.sessionManager.getSessionId(), parentSessionFile: this.ctx.sessionManager.getSessionFile(),
      runtimeSnapshotHost: this.pi, intercomBridge: { mode: 'off' },
      capabilityCeiling: this.api.ceiling.resolveCurrentSubagentCapabilityCeiling(this.ctx.sessionManager.getSessionId()),
    });
    if (!result.ok) throw new Error(`Required ${role}/${r.agent} unavailable: ${result.message}`);
    if (!result.contract.model || !this.ctx.modelRegistry.getAvailable().some(m => `${m.provider}/${m.id}` === result.contract.model.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/, ''))) throw new Error(`Required authenticated model unavailable for ${r.agent}: ${result.contract.model ?? 'unresolved'}`);
    if (r.skill && !result.contract.skills.resolved.some((s: { name: string }) => s.name === r.skill)) throw new Error('Required skill unavailable: ' + r.skill);
    if (r.readOnly) {
      const unexpected = result.contract.tools.effectiveAllowlist.filter((t: string) => !['read','grep','find','ls','structured_output'].includes(t));
      if (unexpected.length) throw new Error(`Cannot enforce read-only agent tools: ${unexpected.join(', ')}`);
    }
    return result.contract;
  }
  private async ownerReady() {
    const requestId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const off = this.pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (reply: any) => {
        if (reply?.version !== 1 || reply.requestId !== requestId || (reply.method && reply.method !== 'ping')) return;
        clearTimeout(timer); off();
        if (reply.success === true && reply.data?.version === 1) resolve();
        else reject(new Error('pi-subagents owner ping failed: ' + (reply.error?.message ?? 'invalid reply')));
      });
      const timer = setTimeout(() => { off(); reject(new Error('pi-subagents owner unavailable: no ping reply within 3 seconds; load pi-subagents in a standalone Pi session')); }, 3000);
      try { this.pi.events.emit('subagents:rpc:v1:request', { version: 1, requestId, method: 'ping', source: { extension: 'pi-factory' } }); }
      catch (error) { clearTimeout(timer); off(); reject(error); }
    });
  }
  async preflight(cwd: string) {
    await this.ownerReady();
    for (const role of Object.keys(roles)) { const ceiling = this.ceiling(role); try { await this.contract(role, cwd); } finally { ceiling.dispose(); } }
  }
  async run(role: string, task: string, cwd: string, identity: { requestId: string; ownerRunId: string; nodeId: string }, signal?: AbortSignal) {
    await this.ownerReady();
    const r = roles[role]; const ceiling = this.ceiling(role);
    try {
      await this.contract(role, cwd);
      if (signal?.aborted) throw new Error('Cancelled before delegation');
      const d = this.api.delegation;
      return await new Promise((resolve, reject) => {
        let settled = false;
        const match = (p: any) => p?.requestId === identity.requestId && p?.ownerRunId === identity.ownerRunId && p?.nodeId === identity.nodeId;
        const finish = (error?: Error, value?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); off(); offUpdate(); signal?.removeEventListener('abort', cancel); error ? reject(error) : resolve(value); };
        const off = this.pi.events.on(d.SUBAGENT_DELEGATION_RESPONSE_EVENT, (p: any) => {
          if (!match(p)) return;
          if (p.status !== 'completed' || p.result?.kind !== 'structured') finish(new Error(`Agent ${role}: ${p.status}: ${p.error ?? 'no structured result'}`));
          else { this.progress(p); finish(undefined, p.result.value); }
        });
        const offUpdate = this.pi.events.on(d.SUBAGENT_DELEGATION_UPDATE_EVENT, (p: any) => { if (match(p)) this.progress(p); });
        // Cancellation is acknowledged only by the package terminal response, never by this signal.
        const cancel = () => this.pi.events.emit(d.SUBAGENT_DELEGATION_CANCEL_EVENT, identity);
        const timer = setTimeout(() => { cancel(); finish(new Error('Delegation terminal response missing; operation uncertain, controller blocked')); }, 35 * 60_000);
        signal?.addEventListener('abort', cancel, { once: true });
        this.pi.events.emit(d.SUBAGENT_DELEGATION_REQUEST_EVENT, { ...identity, agent: r.agent, task, cwd, context: 'fresh', skill: r.skill, intercomBridge: { mode: 'off' }, timeoutMs: 30 * 60_000, artifacts: true, result: { kind: 'structured', schema: r.schema } });
        if (signal?.aborted) cancel();
      });
    } finally { ceiling.dispose(); }
  }
}
