# ADR 0010 — Phase 23 final integration: production env validation CLI, `.env.production.example` template, sweep-fix of leftover Phase 20 typecheck regressions

- **Status:** Accepted
- **Date:** 2026-05-22
- **Deciders:** Founding engineering (jwillz7667)
- **Supersedes:** —
- **Superseded by:** —
- **Relates to:** ADR 0009 (Phase 22 — runbooks/legal/launch-checklist; this phase finishes the loose ends that the launch checklist points at)

## Context

`docs/CLAUDE-CODE-PHASES.md` was authored against a 22-phase plan; Phase 23 was named only in passing inside ADR 0009 ("Alternative B — Skip Phase 22 entirely, ship Phase 23 (final integration) directly") as the placeholder for "the work that closes the launch loop after Phase 22's runbooks and checklist land." It had no entries in the Phase Index, no Goal section, no Definition of Done.

Three concrete loose ends carried over from Phase 22 into this slot:

1. **The launch checklist points at a CLI that doesn't exist.** `docs/LAUNCH-CHECKLIST.md` §2.3 says: _"Successful boot is verified by a one-time `pnpm --filter @dankdash/api run env-check` on the production environment."_ No such script exists in `apps/api/package.json`; no `env-check` entrypoint exists in the codebase. The checklist also referenced `packages/config/src/env.schema.ts` — the actual file is `env.ts` and there is no `.schema.ts` sibling. A reader running the checklist hits a wall on the very first boot-validation step.

2. **There is no production env template.** The repo carries `.env.example` (dev defaults — `localhost`, `NODE_ENV=development`, `LOG_LEVEL=debug`). The platform lead provisioning `.env.production` against Railway secret manager has no documentation listing which variable comes from which secret store, which credentials are sandbox-rejected by `EnvSchema`, or what the production-strict overlay enforces beyond the schema.

3. **Phase 20 left typecheck regressions in `apps/api`.** `pnpm --filter @dankdash/api typecheck` failed on three errors in `apps/api/src/modules/drivers/services/`: a missing import (`OrderEventsService` from `../../orders/order-events.service.js` — the real type is `OrderTransitionService` at `order-transition.service.js`), a missing method (`OrderEventsRepository.listTimelineForOrder` — the real name is `listForOrder`), and two test fixtures missing the post-Phase-20 `Order` columns (`paymentFailedAt`, `rejectedAt`, `preppingAt`, `awaitingDriverAt`, `dispatchFailedAt`, `driverAssignedAt`, `enRoutePickupAt`, `enRouteDropoffAt`, `arrivedAtDropoffAt`, `idScanPendingAt`, `returnedToStoreAt`, `disputedAt`, `ratedAt`). The `main` branch is clean; these regressions live only on `phase/22-prelaunch-runbooks-legal-launch-checklist`. They would block the next typecheck-gated CI run.

The build plan's intent for the final phase is "the platform can launch." A phase that ends with a broken typecheck and a launch checklist that references a non-existent CLI does not satisfy that intent.

## Decision

Phase 23 ships three artifacts and one sweep-fix:

1. **`packages/config/src/env-check.ts`** — pure functions enforcing the production-strict overlay that `EnvSchema` cannot. Banned localhost hosts on `DATABASE_URL` / `REDIS_URL` / `CHECKOUT_BASE_URL`. Banned `debug` / `trace` log levels in production. Required `SENTRY_DSN` and `OTEL_EXPORTER_OTLP_ENDPOINT` (per launch-checklist §8). Feature-flag/credential coherence — `ENABLE_AEROPAY=true` requires non-test Aeropay credentials and a non-sandbox base URL, and same for Persona / Veriff / Metrc. Twilio sender XOR — exactly one of `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_FROM_NUMBER`. JWT key-pair coherence — `JWT_PUBLIC_KEY_BASE64` must be the actual public half of `JWT_PRIVATE_KEY_BASE64` (a mismatched pair is the single most common rotation foot-gun and `EnvSchema` accepts it because both are non-empty base64 strings). Composed by `runAllChecks`, formatted by `formatIssueReport`. 27 unit tests cover every rule (matched/mismatched pairs, all four feature groups, both Twilio failure modes, every banned-host variant). No I/O, no Docker, no testcontainers — tests run in 9ms.

2. **`apps/api/src/cli/env-check.ts`** — thin CLI shim invoked by `pnpm --filter @dankdash/api run env-check`. Calls `loadEnv()` (catching `EnvValidationError`), then `runAllChecks(env)`, writes the report to stderr on failure, exits 0/1/2.

3. **`.env.production.example`** — repo-tracked production env template. Documents every required key and its production secret-store source (`<FROM:Railway → service postgres → DATABASE_URL_PRIVATE>`, `<FROM:1Password vault DankDash/prod-secrets/jwt>`, `<FROM:Aeropay dashboard → Live → API credentials>`, etc.) using a `<FROM:…>`/`<COMPUTED>`/`<DEFAULT>` placeholder vocabulary so a reader can never confuse a documentation marker with a real secret. Verified against `.gitignore` that the file is trackable.

4. **Sweep-fix of the Phase 20 typecheck regressions** in `apps/api/src/modules/drivers/services/driver-orders.service.ts`, `driver-orders.service.test.ts`, and `driver-id-scan.service.test.ts`. Mechanical: rename the wrong type/method, add the missing fixture columns. No behavioral changes.

The launch checklist is updated to reference the correct config file path (`env.ts`, not `env.schema.ts`) and to describe what `env-check` actually does, not just that it should be run.

## Consequences

### Positive

- **The launch checklist is now executable.** A reader running through §2 can reach §2.3, run the command, and either see `env-check: ok (NODE_ENV=production)` or get a precise list of every misconfigured variable and what's wrong with it. The "boot validation" step no longer points at a phantom file.
- **The production env handoff is no longer tribal knowledge.** `.env.production.example` documents where each secret lives in production — Railway secret manager, 1Password vault, vendor dashboard. The platform lead and on-call engineer can both materialize `.env.production` without asking a teammate.
- **The next CI run on `phase/22-...` is unblocked.** With the drivers-module fixes, `pnpm --filter @dankdash/api typecheck` exits 0 and `pnpm typecheck` for the full monorepo passes.
- **The env-check seam is reusable.** The pure functions in `@dankdash/config/env-check` are not API-specific — `apps/workers` and `apps/realtime` can mount the same CLI under their own `package.json` if they ever need their own production-env validators. Today only the API runs the gate; the seam is ready.

### Negative

- **`env-check` is a single forward path; there's no `--dry-run` or `--profile` flag.** A staging deploy that wants to run "the production-strict overlay against the staging env" has to lie about `NODE_ENV` to do so. Acceptable for now — the launch checklist is a one-shot gate, not a continuous-integration suite. A future ADR can add flags if the need surfaces.
- **The `<FROM:…>` placeholder vocabulary in `.env.production.example` is a documentation convention, not a programmatic one.** A platform lead who literally copies the file with placeholders intact will get a clean `EnvSchema` failure on every required field — but they won't get a single dedicated "you forgot to fill in the template" message. The schema's existing missing-field errors are clear enough that adding a placeholder-sniffer was not worth the surface area.

### Risks

- **A future ADR could change which production-strict rules apply, and the `runAllChecks` composition becomes a single source of truth that's easy to extend incorrectly.** Mitigation: every check is its own exported function with its own unit-test suite (`checkProductionStrict`, `checkFeatureFlagCoherence`, `checkTwilioSenderCoherence`, `checkJwtKeyPair`). Adding a new check requires adding a function with tests and wiring it into `runAllChecks`; the cost is intentional.
- **The drivers-module sweep-fix touches three files in `apps/api` that already have integration tests passing.** Mitigation: the change is restricted to a type rename, a method rename, and adding `null` columns to two test fixtures. No service-layer code path's behavior changes. The api typecheck (which is the gate) confirms.

## Alternatives considered

### Alternative A — Skip the env-check CLI; rely on `EnvSchema` boot validation alone

Rejected. `EnvSchema` accepts a JWT keypair where the public key is from a different keypair than the private key — both are non-empty base64 strings. It accepts `AEROPAY_CLIENT_ID=test_xyz` in production. It accepts `LOG_LEVEL=debug` in production. It accepts both Twilio senders being unset (silent SMS no-op). Each of these is a real production foot-gun the launch-checklist explicitly wants to catch _before_ the process boots and starts taking requests. The static shape validator can't catch any of them.

### Alternative B — Ship the env-check CLI but not `.env.production.example`

Rejected. The CLI tells the platform lead _what's wrong_; the template tells them _what to fill in and where to get it_. Without the template, the first launch-checklist run produces a wall of "X must be set" errors and the operator has no canonical document listing which secret-store each X lives in. The template is the predecessor to the CLI, not a duplicate of it.

### Alternative C — Defer the drivers-module typecheck fixes to a separate PR

Rejected. The Phase 23 Definition of Done in this ADR requires `pnpm typecheck` green across the monorepo. Leaving the api package broken means the phase ships with a known-red gate, which contradicts the build-plan's "no half-finished implementations" rule. The fixes are mechanical, isolated, and ~30 lines total; carrying them as a separate PR would be ceremonial overhead with no review value.

### Alternative D — Wait for Phase 22 to merge to `main` and base Phase 23 on `main`

Rejected. `phase/22` is the chain that contains the launch checklist that `env-check` is meant to satisfy. Basing Phase 23 on `main` would mean `LAUNCH-CHECKLIST.md` references a CLI from a branch that doesn't yet exist on the same checkout. The phases are designed to chain; this one chains.

## Verification

Phase 23 Definition of Done (as authored in this PR's `docs/CLAUDE-CODE-PHASES.md` Phase 23 section):

- [x] `pnpm --filter @dankdash/api run env-check` exists in `apps/api/package.json` scripts.
- [x] `runAllChecks` exported from `@dankdash/config`; barrel index reflects the new public surface.
- [x] `packages/config/src/env-check.test.ts` covers every check function — 27 tests pass in <10ms with no testcontainers.
- [x] `.env.production.example` exists at repo root, lists every `EnvSchema` key, and is not gitignored (`git check-ignore -v .env.production.example` exits 1).
- [x] `docs/LAUNCH-CHECKLIST.md` §2.1 and §2.3 reference the correct file paths and describe `env-check`'s actual behavior.
- [x] `pnpm --filter @dankdash/api typecheck` exits 0 (the Phase 20 regressions are fixed).
- [x] `pnpm --filter @dankdash/config typecheck` and `pnpm --filter @dankdash/config test` both exit 0.
- [x] Conventional-commit history, one logical commit per artifact.
- [x] `PROGRESS.md` updated with the Phase 23 entry.
- [x] `docs/CLAUDE-CODE-PHASES.md` Phase Index now has a row for Phase 23, and a `# PHASE 23` section with Goal, Tasks, and DoD.
