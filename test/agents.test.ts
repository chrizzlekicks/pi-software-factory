import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PiAgents } from '../src/agents.ts';

function fixture() {
  const handlers = new Map<string, Set<(p: any) => void>>();
  const events = { on(name: string, fn: (p: any) => void) { const set = handlers.get(name) ?? new Set(); handlers.set(name, set); set.add(fn); return () => set.delete(fn); }, emit(name: string, p: any) { for (const fn of handlers.get(name) ?? []) fn(p); } };
  let disposed = 0, valid = true, owner = true;
  events.on('subagents:rpc:v1:request', p => { if (owner) events.emit(`subagents:rpc:v1:reply:${p.requestId}`, { version: 1, requestId: p.requestId, method: 'ping', success: true, data: { version: 1 } }); });
  const delegation = { SUBAGENT_DELEGATION_REQUEST_EVENT: 'request', SUBAGENT_DELEGATION_RESPONSE_EVENT: 'response', SUBAGENT_DELEGATION_UPDATE_EVENT: 'update', SUBAGENT_DELEGATION_CANCEL_EVENT: 'cancel' };
  const api: any = { delegation, ceiling: { registerSubagentCapabilityCeiling: () => ({ dispose() { disposed++; } }), resolveCurrentSubagentCapabilityCeiling: () => ({}) }, preflight: { resolveSubagentLaunchContract: async () => valid ? { ok: true, contract: { model: 'p/m', skills: { resolved: [] }, tools: { effectiveAllowlist: ['read'] } } } : { ok: false, message: 'missing' } } };
  const ctx: any = { sessionManager: { getSessionId: () => 'session', getSessionFile: () => undefined }, isProjectTrusted: () => true, modelRegistry: { getAvailable: () => [{ provider: 'p', id: 'm' }], getAll: () => [] }, scopedModels: [] };
  return { events, agents: new PiAgents({ events } as any, ctx, api), disable: () => { valid = false; }, disableOwner: () => { owner = false; }, disposed: () => disposed };
}
const id = { requestId: 'r', ownerRunId: 'o', nodeId: 'n' };
test('delegation correlates all identity fields and accepts structured terminal result', async () => {
  const f = fixture(); let request: any;
  f.events.on('request', p => { request = p; f.events.emit('response', { ...id, nodeId: 'other', status: 'failed' }); queueMicrotask(() => f.events.emit('response', { ...id, status: 'completed', result: { kind: 'structured', value: { ok: true } } })); });
  assert.deepEqual(await f.agents.run('worker', 'work', '/tmp', id), { ok: true }); assert.equal(request.agent, 'worker'); assert.equal(f.disposed(), 1);
});
test('terminal failure rejects and cancellation waits for terminal response', async () => {
  const f = fixture(); const abort = new AbortController(); let cancelled = false;
  f.events.on('request', () => abort.abort());
  f.events.on('cancel', p => { assert.deepEqual(p, id); cancelled = true; queueMicrotask(() => f.events.emit('response', { ...id, status: 'cancelled', error: 'stopped' })); });
  await assert.rejects(f.agents.run('worker', 'work', '/tmp', id, abort.signal), /cancelled/); assert.equal(cancelled, true); assert.equal(f.disposed(), 1);
});
test('required launch preflight failure prevents delegation', async () => {
  const f = fixture(); f.disable(); let called = false; f.events.on('request', () => { called = true; });
  await assert.rejects(f.agents.run('worker', 'work', '/tmp', id), /unavailable/); assert.equal(called, false); assert.equal(f.disposed(), 1);
});

test('preflight accepts recognized thinking suffix and passes the delegation schema', async () => {
  const f = fixture(); let seen: any;
  f.agents.api.preflight.resolveSubagentLaunchContract = async (input: any) => { seen = input; return { ok: true, contract: { model: 'p/m:high', skills: { resolved: [] }, tools: { effectiveAllowlist: ['read'] } } }; };
  f.events.on('request', p => { assert.deepEqual(seen.outputSchema, p.result.schema); queueMicrotask(() => f.events.emit('response', { ...id, status: 'completed', result: { kind: 'structured', value: {} } })); });
  await f.agents.run('quality', 'review', '/tmp', id);
  f.agents.api.preflight.resolveSubagentLaunchContract = async () => ({ ok: true, contract: { model: 'p/m:bogus', skills: { resolved: [] }, tools: { effectiveAllowlist: ['read'] } } });
  await assert.rejects(f.agents.run('quality', 'review', '/tmp', id), /model unavailable/);
});

test('read-only preflight permits structured output but rejects unexpected tools', async () => {
  const f = fixture(); let tools = ['read', 'grep', 'find', 'ls', 'structured_output'];
  f.agents.api.preflight.resolveSubagentLaunchContract = async () => ({ ok: true, contract: { model: 'p/m', skills: { resolved: [] }, tools: { effectiveAllowlist: tools } } });
  f.events.on('request', () => queueMicrotask(() => f.events.emit('response', { ...id, status: 'completed', result: { kind: 'structured', value: {} } })));
  await f.agents.run('quality', 'review', '/tmp', id);
  tools = [...tools, 'bash', 'write', 'contact_supervisor'];
  await assert.rejects(f.agents.run('quality', 'review', '/tmp', id), /Cannot enforce read-only agent tools: bash, write, contact_supervisor/);
});

test('an abort during launch preflight prevents delegation', async () => {
  const f = fixture(); const abort = new AbortController(); let called = false;
  f.agents.api.preflight.resolveSubagentLaunchContract = async () => { abort.abort(); return { ok: true, contract: { model: 'p/m:low', skills: { resolved: [] }, tools: { effectiveAllowlist: ['read'] } } }; };
  f.events.on('request', () => { called = true; });
  await assert.rejects(f.agents.run('quality', 'review', '/tmp', id, abort.signal), /cancelled/i);
  assert.equal(called, false);
});

test('inactive owner fails before dispatch', async () => {
  const f = fixture(); f.disableOwner(); let called = false;
  f.events.on('request', () => { called = true; });
  await assert.rejects(f.agents.run('quality', 'review', '/tmp', id), /owner unavailable/);
  assert.equal(called, false);
});
