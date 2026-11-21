# Docker test rig

Validated: 41/41 host tests and 41/41 tests in the offline container passed. The legacy Docker builder path was verified. The image runs as nonroot uid 1000; a new named volume is writable and persists after container removal. Entrypoint mode guards were verified. A native Pi standalone read-only reviewer smoke passed before Docker work. Native in-container model calls/authentication and actual GitHub draft delivery remain untested; no real push was authorized.

Build from the project directory (build needs network access):

```sh
docker build -f docker/Dockerfile -t pi-factory-test .
docker volume create pi-factory-work
docker run --rm --network none -v pi-factory-work:/workspace pi-factory-test
```

The default runs the full `npm test` suite, including fake agents, real disposable Git repositories and fake `gh`. It exits with the test status; no model, GitHub credential or runtime network is required. The regression tests are part of that suite. Run them through the dedicated test-runner. No actual GitHub delivery is tested.

The image installs Node 24, Pi 1.5.2 and pi-subagents 0.88.0; the latter is installed with Pi's package manager, including its built-in agents, skills and prompts. To update, check [compatibility](../COMPATIBILITY.md), update the exact versions in the Dockerfile together, rebuild, and independently run the tests and live smoke. The context is allowlisted; do not put secrets in the included source files. Nothing copies host Pi settings or auth during build.

## Read-only live smoke

From a configured standalone host shell, `npm run smoke:live` runs the same probe. It refuses `PI_SUBAGENT_CHILD=1` and does not modify inherited capability, security, budget, depth, or model settings. Run it from the project root; it can incur model usage and does not run factory delivery or GitHub CLI.

Mount only the two existing agent definitions and the installed review skill, plus optional Pi auth. The copies go into the container's ephemeral home; host files remain read-only. The mounted definitions retain their model assignments; built-in agents use container defaults. Host pi-subagents `agentOverrides`, `defaultModel`, and `defaultProvider` settings are not copied, so built-in agents may use different models; check availability and authentication before running. The smoke makes real model calls and can incur charges, but does not invoke GitHub delivery. Do not pass a GitHub token.

```sh
docker run --rm --network bridge \
  --mount type=bind,src="$HOME/.pi/agent/agents/test-runner.md",dst=/run/factory-agents/test-runner.md,readonly \
  --mount type=bind,src="$HOME/.pi/agent/agents/docs-auditor.md",dst=/run/factory-agents/docs-auditor.md,readonly \
  --mount type=bind,src="$HOME/.pi/agent/git/github.com/DietrichGebert/ponytail/skills/ponytail-review",dst=/run/factory-skill,readonly \
  --mount type=bind,src="$HOME/.pi/agent/auth.json",dst=/run/secrets/pi-auth.json,readonly \
  pi-factory-test smoke
```

Alternatively omit the auth mount and pass `-e OPENAI_API_KEY` (or `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`) from your environment. A mounted auth file is copied with mode 600. API variables are visible to container processes; don't share them with untrusted code. The smoke checks authentication and launches a read-only reviewer; it does not exercise the complete pipeline.

Host local delivery is available as described in the project README. The container live entrypoint requires GitHub configuration, and factory requests select GitHub delivery for github.com origins.

## Authorized live sandbox only

Only use a disposable GitHub repository you own or are explicitly authorized to change. This mode exposes `GH_TOKEN` to Pi, agents and commands; a successful factory run can automatically push a branch and create a real draft PR. It is not executed by the default test or smoke. Set `GH_TOKEN` in your shell and use a suitably scoped token, then run (replace the URL):

```sh
docker run -it --rm --network bridge -v pi-factory-work:/workspace \
  -e FACTORY_LIVE_ENABLE=1 -e GH_TOKEN \
  -e GIT_AUTHOR_NAME -e GIT_AUTHOR_EMAIL -e GIT_COMMITTER_NAME -e GIT_COMMITTER_EMAIL \
  -e FACTORY_REPO_URL=https://github.com/OWNER/SANDBOX.git \
  --mount type=bind,src="$HOME/.pi/agent/agents/test-runner.md",dst=/run/factory-agents/test-runner.md,readonly \
  --mount type=bind,src="$HOME/.pi/agent/agents/docs-auditor.md",dst=/run/factory-agents/docs-auditor.md,readonly \
  --mount type=bind,src="$HOME/.pi/agent/git/github.com/DietrichGebert/ponytail/skills/ponytail-review",dst=/run/factory-skill,readonly \
  --mount type=bind,src="$HOME/.pi/agent/auth.json",dst=/run/secrets/pi-auth.json,readonly \
  pi-factory-test live
```

The URL must be a plain HTTPS github.com owner/repository URL. All four Git author/committer identity variables shown above must be set in your shell before running; the container does not inherit your host Git identity. Live mode configures `gh` as Git credential helper in the ephemeral home before cloning; the token must have the required repository access. In Pi use `/factory <description>` for a draft PR; GitHub delivery is selected for this origin. The request starts execution without an approval gate. See the [project README](../README.md) for recovery and safety limits.

`/workspace/repo` is an independent clone including its own `.git`; factory state and reports live beneath that Git directory; new runs use retained isolated worktrees and factory branches on the named volume. Reusing a volume with a different origin is refused rather than overwritten. Docker initializes a **new empty named volume** from the image-owned `/workspace`, making it writable by the nonroot `node` user without runtime chown. Existing volumes, bind mounts, user-namespace remapping, and host-mounted directories may have incompatible ownership; use a new named volume rather than changing ownership of host files. `--rm` removes the container, not the named volume; delete the volume only after preserving needed artifacts. Logs and reports may contain secrets.

This is not an OS sandbox: trusted repositories, agents and planned commands can access the container network, filesystem and exposed credentials. No host project, entire Pi agent directory, Docker socket, privileged mode or root runtime is needed. Berger/tmux are not included; display integration is optional and not needed for the rig. The host's model settings beyond the selective agent definitions are not copied; supply any additional required provider configuration deliberately.
