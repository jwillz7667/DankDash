#!/usr/bin/env bash
# Forbid copyleft and source-disclosure-triggering licenses in
# production dependencies.
#
# DankDash distributes proprietary backend services; bundling a GPL /
# AGPL / LGPL package (or one of the source-disclosure SSPL/EUPL/etc.
# variants) transitively obligates us to release source. This script
# enumerates every production dependency, groups them by SPDX license,
# and fails the build on a forbidden entry.
#
# Dev dependencies (linters, build tools, test frameworks) are
# intentionally excluded: GPL tooling is fine as long as we do not
# bundle it into the shipped artifact.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "audit-licenses: pnpm is not installed" >&2
  exit 1
fi

# `pnpm licenses list --prod --json` returns an object keyed by license
# name; each value is the list of packages under that license. We pipe
# through node so we do not depend on jq being available in CI images.
output="$(pnpm licenses list --prod --json 2>/dev/null || true)"

if [[ -z "${output}" ]]; then
  echo "audit-licenses: pnpm licenses list produced no output (no installed deps?)" >&2
  exit 1
fi

violations="$(
  node --input-type=module -e "
    const raw = process.argv[1];
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      console.error('audit-licenses: pnpm licenses output was not JSON');
      console.error(err.message);
      process.exit(2);
    }
    // SPDX prefixes for licenses that either compel source disclosure
    // (GPL/AGPL/LGPL family) or carry strong copyleft / commercial-use
    // restrictions incompatible with a closed-source SaaS distribution.
    const forbidden = /^(AGPL|GPL|LGPL|EPL|MS-PL|CDDL|EUPL|OSL|RPL|SSPL|BUSL|CC-BY-NC)/i;
    const lines = [];
    for (const [license, pkgs] of Object.entries(data)) {
      if (!forbidden.test(license)) continue;
      for (const pkg of pkgs) {
        lines.push(\`\${license}: \${pkg.name}@\${pkg.version}\`);
      }
    }
    process.stdout.write(lines.join('\n'));
  " \
  "${output}"
)"

if [[ -n "${violations}" ]]; then
  cat >&2 <<EOF
audit-licenses: forbidden license detected in production dependencies

${violations}

DankDash cannot ship production code that pulls in a copyleft
(GPL / AGPL / LGPL / EPL / MS-PL / CDDL / EUPL / OSL / RPL / SSPL)
or non-commercial (BUSL / CC-BY-NC) license. Options:
  1. Replace the dependency with a permissively-licensed alternative.
  2. If the package is build-only and never bundled, move it from
     "dependencies" into "devDependencies".
  3. If the package's effective license is permissive but pnpm
     misreports it (uncommon), upstream the SPDX correction.

Exemptions require legal review and a separate written waiver.
EOF
  exit 1
fi

echo "audit-licenses: 0 forbidden licenses in production deps"
