# Compatibility

The extension targets Pi coding agent 1.5.2 slash commands and pi-subagents 0.88.0 structured owned-leaf delegation, launch preflight and capability ceilings. The Pi host packages are wildcard peers (`*`) per Pi's package convention; Pi 1.5.2 is the tested compatibility baseline, not a peer-version pin. pi-subagents is an optional npm peer because it may be loaded from a separate global installation, but remains operationally required and must be installed and loaded separately; set `PI_FACTORY_SUBAGENTS_PATH` if package resolution cannot find it. Runtime preflight requires the configured architect, worker, test-runner, reviewer and docs-auditor agents, authenticated models, and ponytail-review skill. Availability depends on the user's Pi configuration. The architect is trusted, not strictly read-only: before approval it can delegate to `scout`, whose permitted `bash` and `write` can run host commands and write output, and web extensions may have side effects or send data externally. Ceilings are inherited by scouts but are not a sandbox. Plan validation and approval still gate implementation and delivery, not planner activity.

Configure the separately installed architect agent to prioritize the factory structured plan schema, and set its frontmatter `tools: subagent, web_enable, web_search, source_check, fetch_content, get_search_content` and `subagentOnlyExtensions` to the absolute path of the installed pi-web-access `dist/index.js`. Use pi-web-access's default tool names and set `toolActivation: dynamic` in its `web-search.json` so `web_enable` is registered; do not disable those web tools. A missing provider or tool fails child startup, and search availability depends on network and provider credentials. The factory preflight checks delegation, `web_enable`, fanout authorization and presence of a configured extension, not activation of dynamically exposed tools, provider identity or live web access. An unrelated extension can satisfy the extension check: preflight success is not proof that web tools will activate or that research will work. Verify the installed provider and configuration independently; failed activation or unavailable network/credentials can still break research at runtime. The default `source_check` tool must also be allowed because `web_enable` activates all enabled web capabilities together. Other planner extension configurations are trusted too; avoid loading untrusted extensions. The planner ceiling permits only architect, scout and researcher descendants; scout tools remain subject to their own configuration and the inherited ceiling.

Node 24 provides native TypeScript stripping. Git and a configured author/committer identity are required. Default local delivery requires a clean existing checkout but no origin or GitHub CLI; model authentication remains necessary. Explicit `--delivery github` requires authenticated GitHub CLI and supports a github.com origin, a clean default-branch checkout and write permissions, and creates only a new factory branch and draft PR. No real GitHub integration has been verified by the local tests. Capability ceilings are not an OS sandbox. Berger is optional and display-only: a best-effort coarse lifecycle display is emitted when its executable is available. The local `pi-factory:phase` event carries exact persisted phases and run ID; state and reports remain authoritative. Pi 1.5.2 uses its host module instances through Jiti virtual modules to load the installed pi-subagents APIs; bundled and unbundled host loading outside the tested CLI remains unverified.

New runs use the existing clean checkout on an approved new factory branch, with exclusive use until completion or cancellation; no worktree is created. Legacy nonterminal worktree runs require manual recovery.

For test-rig instructions and validation results, see [Docker test rig](docker/README.md).

For web research, configure the built-in pi-subagents `researcher` through `~/.pi/agent/settings.json` (merge into existing settings; replace the path with your installed provider):

```json
{
  "subagents": {
    "agentOverrides": {
      "researcher": {
        "tools": [
          "read",
          "write",
          "web_enable",
          "web_search",
          "source_check",
          "fetch_content",
          "get_search_content"
        ],
        "subagentOnlyExtensions": ["/absolute/path/to/pi-web-access/dist/index.js"]
      }
    }
  }
}
```

This changes fields on the built-in agent, not its research prompt; do not create a researcher agent file. The planner instructs researcher to call `web_enable` first. Architect delegation must allow both `scout` and `researcher` (including any `allowedAgents` restriction). The architect routes repository inspection to scout and external research to researcher. Researcher launch and web availability are not checked by factory preflight; project agent overrides can change the resolved configuration.
