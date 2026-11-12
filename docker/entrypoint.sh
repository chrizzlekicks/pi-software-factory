#!/bin/sh
set -eu
mode=${1:-test}
case "$mode" in
  test|smoke|live) ;;
  *) echo 'Usage: factory-entrypoint [test|smoke|live]' >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo 'Unexpected arguments' >&2; exit 2; }
if [ "$mode" != live ] && { [ -n "${GH_TOKEN:-}" ] || [ -n "${GITHUB_TOKEN:-}" ] || [ -n "${GH_ENTERPRISE_TOKEN:-}" ] || [ -n "${GITHUB_ENTERPRISE_TOKEN:-}" ]; }; then
  echo 'GitHub tokens are only allowed in live mode' >&2; exit 2
fi
if [ "$mode" = test ]; then
  cd /opt/factory
  exec npm test
fi
if [ "$mode" = live ]; then
  [ "${FACTORY_LIVE_ENABLE:-}" = 1 ] && [ -n "${GH_TOKEN:-}" ] || { echo 'live requires FACTORY_LIVE_ENABLE=1 and GH_TOKEN' >&2; exit 2; }
  case "${FACTORY_REPO_URL:-}" in
    https://github.com/*/*) ;;
    *) echo 'live requires an https://github.com/owner/repo clone URL' >&2; exit 2 ;;
  esac
  # Only plain GitHub owner/repository names; no credentials, options, query or shell syntax.
  repo=${FACTORY_REPO_URL#https://github.com/}
  owner=${repo%%/*}; name=${repo#*/}
  case "$owner/$name" in *[!A-Za-z0-9_.\/-]*|/*|*/|*/*/*) echo 'Invalid GitHub repository URL' >&2; exit 2;; esac
fi
for file in test-runner.md docs-auditor.md; do
  [ -f "/run/factory-agents/$file" ] || { echo "Missing /run/factory-agents/$file" >&2; exit 2; }
done
[ -f /run/factory-skill/SKILL.md ] || { echo 'Missing ponytail-review skill' >&2; exit 2; }
if [ ! -f /run/secrets/pi-auth.json ] && [ -z "${ANTHROPIC_API_KEY:-}${OPENAI_API_KEY:-}${GEMINI_API_KEY:-}" ]; then
  echo 'Missing Pi auth secret or supported provider API key' >&2; exit 2
fi
umask 077
mkdir -p "$HOME/.pi/agent/agents" "$HOME/.pi/agent/skills/ponytail-review"
cp /run/factory-agents/test-runner.md /run/factory-agents/docs-auditor.md "$HOME/.pi/agent/agents/"
cp -R /run/factory-skill/. "$HOME/.pi/agent/skills/ponytail-review/"
if [ -f /run/secrets/pi-auth.json ]; then
  cp /run/secrets/pi-auth.json "$HOME/.pi/agent/auth.json"
  chmod 600 "$HOME/.pi/agent/auth.json"
fi
if [ "$mode" = smoke ]; then
  cd /opt/factory
  exec npm run smoke:live
fi
gh auth setup-git
if [ ! -e /workspace/repo ]; then
  git clone -- "$FACTORY_REPO_URL" /workspace/repo
else
  [ -d /workspace/repo/.git ] && [ "$(git -C /workspace/repo remote get-url origin)" = "$FACTORY_REPO_URL" ] || { echo 'Existing /workspace/repo does not match URL; preserve it and use a different volume' >&2; exit 2; }
fi
cd /workspace/repo
exec pi -e /opt/factory/src/index.ts
