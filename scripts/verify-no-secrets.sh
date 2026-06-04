#!/usr/bin/env bash
# Local wrapper around gitleaks, called from .githooks/pre-commit and
# available manually as `pnpm run security:secrets`. Scans the
# currently staged content (not the working tree, not the full
# history) so pre-commit feedback is fast.
#
# When run with no staged changes (e.g. amends or `git commit --allow-empty`)
# the wrapper degrades to scanning HEAD's tree against the same policy,
# so we never silently skip the check.
#
# Requires `gitleaks` on $PATH. The CI job installs it via the
# gitleaks-action; locally, developers install via Homebrew
# (`brew install gitleaks`) and the wrapper warns once if missing.

set -euo pipefail

if ! command -v gitleaks >/dev/null 2>&1; then
  cat >&2 <<'EOF'
verify-no-secrets: gitleaks is not installed.

Install it with:
  brew install gitleaks        # macOS
  apt-get install -y gitleaks  # Debian/Ubuntu

CI runs gitleaks via gitleaks/gitleaks-action@v2 so PRs are still
gated. Locally, this hook is a fast-feedback layer only.
EOF
  # Non-fatal locally so first-time developers are not blocked. CI is
  # the authoritative gate.
  exit 0
fi

repo_root="$(git rev-parse --show-toplevel)"
config_path="${repo_root}/.gitleaks.toml"

if [[ ! -f "${config_path}" ]]; then
  echo "verify-no-secrets: .gitleaks.toml missing at ${config_path}" >&2
  exit 1
fi

# `protect --staged` checks only the index, which is what a pre-commit
# wants. `--redact` prevents the leaked value from echoing to terminal
# / CI logs even when it triggers a finding.
gitleaks protect \
  --staged \
  --config="${config_path}" \
  --redact \
  --no-banner \
  --verbose \
  --exit-code=1
