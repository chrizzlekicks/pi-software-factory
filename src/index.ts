import * as codingAgent from '@earendil-works/pi-coding-agent';
import * as agentCore from '@earendil-works/pi-agent-core';
import * as ai from '@earendil-works/pi-ai';
import * as tui from '@earendil-works/pi-tui';
import * as typebox from 'typebox';
import * as typeboxCompile from 'typebox/compile';
import * as typeboxValue from 'typebox/value';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Git } from './git.ts';
import { bergerDisplay } from './berger.ts';
import { Store } from './state.ts';
import { Factory } from './controller.ts';
import { GitHubDelivery } from './delivery.ts';
import { loadSubagents, PiAgents } from './agents.ts';
import { registerFactoryCommands } from './commands.ts';

export default function factoryExtension(pi: ExtensionAPI) {
  let factory: Factory | undefined;
  let initializing: Promise<Factory> | undefined;
  async function get(ctx: ExtensionContext) {
    if (factory) return factory;
    if (initializing) return initializing;
    initializing = (async () => {
    const git = new Git(ctx.cwd);
    const store = new Store(git.stateDir());
    const hostModules = { '@earendil-works/pi-coding-agent': codingAgent, '@earendil-works/pi-agent-core': agentCore, '@earendil-works/pi-ai': ai, '@earendil-works/pi-tui': tui, typebox, 'typebox/compile': typeboxCompile, 'typebox/value': typeboxValue };
    let adapter: Promise<PiAgents> | undefined;
    const getAdapter = () => adapter ??= loadSubagents(hostModules).then(api => new PiAgents(pi, ctx, api)).catch(e => { adapter = undefined; throw e; });
    const agents = { preflight: async (cwd: string) => (await getAdapter()).preflight(cwd), run: async (...args: Parameters<PiAgents['run']>) => (await getAdapter()).run(...args) };
    const display = bergerDisplay();
    factory = new Factory(store, git, agents, new GitHubDelivery(git, store.dir), s => { pi.events.emit('pi-factory:phase', { runId: s.id, phase: s.phase }); display(s); });
    return factory;
    })();
    try { return await initializing; } finally { initializing = undefined; }
  }
  registerFactoryCommands(pi, get, () => { factory?.store.close(); factory = undefined; });
}
