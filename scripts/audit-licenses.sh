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

# The pnpm licenses JSON is fed to node over stdin, not as argv. With
# the full transitive graph (~hundreds of packages once OTel + ioredis
# instrumentations are pulled in), the serialized JSON easily exceeds
# the kernel ARG_MAX limit, which previously broke this script with
# "Argument list too long". Stdin has no such cap.
violations="$(
  printf '%s' "${output}" | node --input-type=module -e "
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
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
      //
      // LGPL is included in the forbidden set as the default policy, but
      // dynamically-linked LGPL native binaries (libvips via sharp) are
      // exempt — LGPL §4 permits proprietary linkage as long as the
      // library can be replaced and is not modified. The allowlist below
      // enumerates the specific packages covered by this exemption; any
      // new LGPL dep falls through to the failure path and forces a
      // legal review.
      const forbidden = /^(AGPL|GPL|LGPL|EPL|MS-PL|CDDL|EUPL|OSL|RPL|SSPL|BUSL|CC-BY-NC)/i;
      const allowedLgplPrefixes = ['@img/sharp-libvips-'];
      const lines = [];
      for (const [license, pkgs] of Object.entries(data)) {
        if (!forbidden.test(license)) continue;
        const isLgpl = /^LGPL/i.test(license);
        for (const pkg of pkgs) {
          if (
            isLgpl &&
            allowedLgplPrefixes.some((p) => pkg.name.startsWith(p))
          ) {
            continue;
          }
          const versions = Array.isArray(pkg.versions)
            ? pkg.versions.join(',')
            : (pkg.version ?? 'unknown');
          lines.push(\`\${license}: \${pkg.name}@\${versions}\`);
        }
      }
      process.stdout.write(lines.join('\n'));
    });
  "
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
