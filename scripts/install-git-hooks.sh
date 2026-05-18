#!/usr/bin/env bash
# Wires the local repository to use the tracked .githooks directory.
# Invoked automatically by the root `prepare` npm script after install.
#
# Skipped when:
#   - CI=true              (CI does not need local pre-commit enforcement)
#   - Running inside CI's `pnpm install --frozen-lockfile` on a non-git tree
#   - The current working tree is not a git checkout

set -euo pipefail

if [[ "${CI:-}" == "true" ]]; then
  exit 0
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

repo_root="$(git rev-parse --show-toplevel)"
hooks_dir="${repo_root}/.githooks"

if [[ ! -d "${hooks_dir}" ]]; then
  echo "install-git-hooks: ${hooks_dir} not found; skipping" >&2
  exit 0
fi

chmod +x "${hooks_dir}"/* 2>/dev/null || true
git -C "${repo_root}" config core.hooksPath .githooks
