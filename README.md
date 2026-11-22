# Pi Software Factory

Pi Software Factory is a Pi extension for an autonomous sequential implementation workflow that can deliver a draft GitHub pull request or a local commit.

## Prerequisites

- Node.js 24 or newer and Git with author and committer identity configured.
- A compatible Pi coding agent and separately installed and loaded pi-subagents extension, with configured and authenticated models. The `architect`, `worker`, `test-runner`, `reviewer`, and `docs-auditor` agents and `ponytail-review` skill must be available.
- A Git checkout with an existing HEAD. GitHub delivery additionally requires authenticated GitHub CLI (`gh`), a supported github.com origin, a named current branch, and repository write access. Local delivery needs no origin, GitHub CLI, or GitHub authentication; model authentication is still required.

See [compatibility](COMPATIBILITY.md) for tested versions and integration limits. Set `PI_FACTORY_SUBAGENTS_PATH` to the installed pi-subagents package directory if package resolution cannot find it.

## Install and use

Install this directory as a Pi package, or load the extension explicitly from your repository checkout:

```sh
pi -e /absolute/path/to/pi-software-factory/src/index.ts
```

In Pi, submit a request with `/factory <description>`. Delivery is GitHub for github.com origins and local when there is no origin. Other origins are unsupported; GitHub delivery does not fall back on failure. The request launches planning and implementation without an approval step. The trusted planner may delegate inspection and retrieve web content; nested agents and loaded extensions can have side effects.

The factory creates an isolated worktree and `factory/...` branch from committed HEAD, excluding changes in the original checkout. It runs tests, three independent reviews, a documentation audit and completion triage, with up to five shared repair rounds. Passing changes receive one final commit with a validated Conventional Commits subject based on the verified changes; an already-satisfied request needs no commit. GitHub mode pushes a new branch and opens a draft PR against the repository default branch recorded at preflight. The PR can include local commits not present on that base; review its full diff. local mode does not push or create a PR. Worktrees are retained.

## Controls and recovery

- `/factory` and `/factory status` show progress and evidence. Control commands are recognized only when the entire trimmed input matches; extra words make it a description. `request` is not an alias and remains part of the description.
- `/factory pause` requests a stop at the next safe boundary; `/factory resume` continues a safe paused run. `/factory cancel` requests cancellation and preserves artifacts.
- `/factory deliver` explicitly retries delivery only for a finalized, delivery-failed run (or verifies an already completed receipt). It does not run agents, tests, repairs or commits. It requires the original clean factory worktree, final commit and gate evidence. GitHub mode reauthenticates, checks that the recorded remote base revision has not changed and reconciles the remote branch and an existing open PR; conflicting branches, closed or merged PRs, and changed targets are refused. Local mode validates or records the local receipt.
- Legacy state is not resumed automatically. Existing `<id>.json` archives, including malformed files, are preserved; differing legacy state is stored as `<id>-legacy-<uuid>.json` alongside them. Matching archives are reused. Inspect preserved state, report and worktree before starting a fresh run; an uncertain active child or delivery operation prevents a fresh run.

Interrupted operations and uncertain delivery block ordinary resume and automatic replay. Inspect the checkout, local and GitHub branches, and PR before explicitly authorizing `/factory deliver`. Remove a stale `writer.lock` only after confirming no writer or child remains. Uncertain child or worktree creation is not replayed; do not delete artifacts or blindly retry. Delivery retry fails closed if its checks cannot establish the original finalized delivery.

## Safety and scope

Do not edit a factory worktree during a run: concurrent human edits cannot be distinguished from agent edits. The original checkout is not stashed, reset or switched. Failed and successful worktrees are retained. State, locks and reports live under the Git common directory's `pi-factory` directory; logs can contain secrets. Scope checks detect Git-visible changes, not every filesystem or network effect. A worktree is not an OS sandbox; agents, commands and symlinks can access locations outside it. Use trusted agents, commands and repositories.

The local `pi-factory:phase` event reports persisted phases. Optional Berger integration is best-effort and display-only; persisted factory state remains authoritative.

For offline tests, live-smoke setup, and validation details, see the [Docker test rig](docker/README.md).

When a scope revision removes an existing verification command, the planner receives the missing commands and may retry up to two times. Other validation failures stop the run; exhausted retries block it without accepting the revision.
