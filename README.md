# Pi Software Factory

Pi Software Factory is a Pi extension for an approval-gated, sequential implementation workflow that delivers either a draft GitHub pull request or local commits. Version 0.1 plans a request, implements it in the existing checkout on a new feature branch, and independently verifies and reviews the result before delivery.

## Prerequisites

- Node.js 24 or newer and Git with author and committer identity configured.
- A compatible Pi coding agent and separately installed and loaded pi-subagents extension, with configured and authenticated models. The `architect`, `worker`, `test-runner`, `reviewer`, and `docs-auditor` agents and `ponytail-review` skill must be available.
- A clean Git checkout with an existing HEAD. GitHub delivery additionally requires authenticated GitHub CLI (`gh`), a supported github.com origin, a checkout at the GitHub default-branch revision, and repository write access. Local delivery needs no origin, GitHub CLI, or GitHub authentication; model authentication is still required.

See [compatibility](COMPATIBILITY.md) for tested versions and integration limits. Set `PI_FACTORY_SUBAGENTS_PATH` to the installed pi-subagents package directory if package resolution cannot find it.

## Install and use

Install this directory as a Pi package, or load the extension explicitly from your repository checkout:

```sh
pi -e /absolute/path/to/pi-software-factory/src/index.ts
```

In Pi, submit a request with `/factory <request>` (or `/factory request <request>`). Local delivery is the default; `--delivery local` is also accepted. For a remote draft PR, use `/factory --delivery github <request>` or `/factory request --delivery github <request>`. The selector must precede the request and appear only once; GitHub delivery does not fall back on failure. The selected mode is shown before approval and remains fixed for the run. The trusted planner may delegate inspection and retrieve web content before approval; it is not strictly read-only. Nested scouts can run host commands and write output, and loaded extensions can have side effects. Approval gates implementation and delivery, not planner activity. The planner proposes allowed paths and executable/argv verification commands. Inspect it carefully, then use `/factory approve` or `/factory reject`. Approval authorizes the plan's paths and commands and the selected delivery mode, which cannot be changed without a new approval; approval is required before the extension can push.

After approval, the factory creates and switches to a new `factory/...` branch in the existing checkout and implements sequentially there, checkpoints changes, runs independent tests and three reviews, and triages findings. It permits at most two repair cycles and re-verifies documentation changes. Only a passing final revision can be delivered. GitHub mode pushes a new factory branch and opens a draft PR requiring human review. Local mode retains the exact committed revision on that branch and checkout, records a local receipt and report, and never pushes or creates a PR.

## Controls and recovery

- `/factory status`, `/factory inspect`, and `/factory report` show progress, persisted state, and evidence.
- `/factory pause` requests a stop at the next safe boundary; `/factory resume` continues a paused approved run. `/factory cancel` requests cancellation and preserves artifacts.
- For an interrupted agent, paused checkout, or quality gate blocked after exhausting repair cycles, with no delivery intent, first confirm all child processes have stopped and inspect the checkout, findings and artifacts, then use `/factory recover inspected` to create a new plan requiring approval. The repair count and prior evidence are retained; verification and review still apply. An interrupted initial planner can also be recovered after cancellation, provided the checkout is clean and still at the original revision; otherwise reconcile manually without discarding changes.

Interrupted operations and uncertain delivery block automatic replay. Inspect the checkout, local and GitHub branches, and PR before acting. Remove a stale `writer.lock` only after confirming no writer or child remains. Uncertain branch creation or delivery requires manual reconciliation; do not delete artifacts or blindly retry. There is no automated delivery reconciliation.

## Safety and scope

The factory exclusively owns the clean checkout during a run; do not edit or switch branches until completion or cancellation. Paused changes require inspected recovery and renewed approval. Concurrent human edits during active commands cannot be distinguished from agent edits. The factory never stashes, resets, cleans, or switches back; failures and cancellation preserve files and branch. New runs use the same checkout, including ignored configuration and dependencies. Legacy nonterminal worktree runs cannot continue automatically; inspect their original worktree and recover manually. Historical reports remain readable. State, locks and reports live under the Git common directory's `pi-factory` directory; logs can contain secrets. Scope checks detect Git-visible changes, not every filesystem or network effect. Agents and approved commands are not OS-sandboxed, and symlinks or malicious commands can write outside the checkout. Use trusted agents, commands, and repositories.

The local `pi-factory:phase` event reports persisted phases. Optional Berger integration is best-effort and display-only; persisted factory state remains authoritative.

For offline tests, live-smoke setup, and validation details, see the [Docker test rig](docker/README.md).
