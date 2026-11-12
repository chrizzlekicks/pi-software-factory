# Pi Software Factory

Pi Software Factory is a Pi extension for an approval-gated, sequential implementation workflow that can deliver a draft GitHub pull request. Version 0.1 plans a request, implements it in a separate worktree, and independently verifies and reviews the result before delivery.

## Prerequisites

- Node.js 24 or newer, Git, and authenticated GitHub CLI (`gh`).
- A compatible Pi coding agent and separately installed and loaded pi-subagents extension, with configured and authenticated models. The `scout`, `worker`, `test-runner`, `reviewer`, and `docs-auditor` agents and `ponytail-review` skill must be available.
- A clean checkout of the GitHub default branch, a supported github.com origin, and write access to the repository. Preflight checks the requirements before work begins.

See [compatibility](COMPATIBILITY.md) for tested versions and integration limits. Set `PI_FACTORY_SUBAGENTS_PATH` to the installed pi-subagents package directory if package resolution cannot find it.

## Install and use

Install this directory as a Pi package, or load the extension explicitly from your repository checkout:

```sh
pi -e /absolute/path/to/pi-software-factory/src/index.ts
```

In Pi, submit a request with `/factory <request>` (or `/factory request <request>`). The planner produces a read-only plan with allowed paths and executable/argv verification commands. Inspect it carefully, then use `/factory approve` or `/factory reject`. Approval authorizes the plan's paths and commands, including eventual remote delivery; it is required before the extension can push.

After approval, the factory implements sequentially in a separate worktree, checkpoints changes, runs independent tests and three reviews, and triages findings. It permits at most two repair cycles and re-verifies documentation changes. Only a passing final revision can be pushed to a new factory branch and opened as a draft PR. Human PR review is still required.

## Controls and recovery

- `/factory status`, `/factory inspect`, and `/factory report` show progress, persisted state, and evidence.
- `/factory pause` requests a stop at the next safe boundary; `/factory resume` continues a paused approved run. `/factory cancel` requests cancellation and preserves artifacts.
- For an interrupted agent with an existing worktree and no delivery intent, first confirm all child processes have stopped and inspect the worktree, then use `/factory recover inspected` to create a new plan requiring approval.

Interrupted operations and uncertain delivery block automatic replay. Inspect the worktree, local and GitHub branches, and PR before acting. Remove a stale `writer.lock` only after confirming no writer or child remains. Uncertain worktree creation or delivery requires manual reconciliation; do not delete artifacts or blindly retry. There is no automated delivery reconciliation.

## Safety and scope

The original checkout is not stashed or cleaned. State, locks, reports, and worktrees live under the Git common directory's `pi-factory` directory; logs can contain secrets. Scope checks detect Git-visible changes, not every filesystem or network effect. Agents and approved commands are not OS-sandboxed, and symlinks or malicious commands can write outside the worktree. Use trusted agents, commands, and repositories.

The local `pi-factory:phase` event reports persisted phases. Optional Berger integration is best-effort and display-only; persisted factory state remains authoritative.

For offline tests, live-smoke setup, and validation details, see the [Docker test rig](docker/README.md).
