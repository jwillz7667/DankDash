#!/usr/bin/env bash
# Local wrapper around semgrep, available manually as `pnpm run
# security:semgrep`. Runs the same ruleset CI runs:
#
#   - p/owasp-top-ten   — OWASP top-10 class issues
#   - p/typescript      — TypeScript-flavoured patterns
#   - p/nodejs          — Node-specific anti-patterns
#   - .semgrep/         — repo-local rules from CLAUDE.md
#
# Hosted rulesets are fetched from registry.semgrep.dev over HTTPS at
# scan time, so this command requires network access.
#
# Semgrep is a Python tool; the CI job uses the
# `returntocorp/semgrep:1.92.0` container image. Locally, developers
# install via Homebrew (`brew install semgrep`) and this wrapper
# warns once if missing.

set -euo pipefail

if ! command -v semgrep >/dev/null 2>&1; then
  cat >&2 <<'EOF'
run-semgrep: semgrep is not installed.

Install it with:
  brew install semgrep         # macOS
  python3 -m pip install semgrep   # cross-platform

CI runs semgrep in the returntocorp/semgrep:1.92.0 container so PRs
are still gated. Locally, this script is a fast-feedback layer only.
EOF
  # Non-fatal locally so first-time developers are not blocked. CI is
  # the authoritative gate.
  exit 0
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "${repo_root}"

if [[ ! -d ".semgrep" ]]; then
  echo "run-semgrep: .semgrep/ ruleset directory missing at ${repo_root}/.semgrep" >&2
  exit 1
fi

# `--error` flips findings into a non-zero exit so this is callable
# from CI without parsing JSON. `--metrics=off` keeps semgrep from
# pinging its telemetry endpoint on every invocation.
semgrep \
  --config=p/owasp-top-ten \
  --config=p/typescript \
  --config=p/nodejs \
  --config=.semgrep \
  --error \
  --metrics=off \
  --exclude='**/node_modules/**' \
  --exclude='**/dist/**' \
  --exclude='**/build/**' \
  --exclude='**/.next/**'
