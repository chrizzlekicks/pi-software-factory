# Compatibility

The extension targets Pi coding agent 1.5.2 slash commands and pi-subagents 0.88.0 structured owned-leaf delegation, launch preflight and capability ceilings. The latter must be installed and loaded separately; set `PI_FACTORY_SUBAGENTS_PATH` if package resolution cannot find it. Runtime preflight requires the configured scout, worker, test-runner, reviewer and docs-auditor agents, authenticated models, and ponytail-review skill. Availability depends on the user's Pi configuration.

Node 24 provides native TypeScript stripping. Git and authenticated GitHub CLI are required. Delivery supports a github.com origin, a clean default-branch checkout and write permissions, and creates only a new factory branch and draft PR. No real GitHub integration has been verified by the local tests. Capability ceilings are not an OS sandbox. Berger is optional and display-only: a best-effort coarse lifecycle display is emitted when its executable is available. The local `pi-factory:phase` event carries exact persisted phases and run ID; state and reports remain authoritative. Pi 1.5.2 uses its host module instances through Jiti virtual modules to load the installed pi-subagents APIs; bundled and unbundled host loading outside the tested CLI remains unverified.

For test-rig instructions and validation results, see [Docker test rig](docker/README.md).
