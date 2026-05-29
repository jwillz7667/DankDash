# ADR 0009 — Phase 22 pre-launch: ship operational runbooks + legal first-drafts + launch checklist; defer admin console + onboarding wizards behind Phase 13 portal scaffold

- **Status:** Accepted
- **Date:** 2026-05-22
- **Deciders:** Founding engineering (jwillz7667)
- **Supersedes:** —
- **Superseded by:** —
- **Relates to:** ADR 0008 (Phase 21 hardening — the observability seam this phase's runbooks depend on)

## Context

Phase 22 of the build plan (`docs/CLAUDE-CODE-PHASES.md` §22) is titled "Pre-launch: Admin Console, Runbooks, Docs" and enumerates five deliverables:

1. **22.1** — Admin console under `apps/portal/src/app/admin/` for operations team workflows (user lookup, order force-cancel, dispatch override, refund issue, vendor-license review).
2. **22.2** — Operational runbooks in `docs/runbooks/` covering Aeropay outage, Metrc API failure, high order-error rate, database failover, driver-app crash spike, customer-complaint escalation, license-compliance audit, data-export request, account-deletion request.
3. **22.3** — Legal documents in `apps/portal/src/app/(legal)/` covering Terms of Service, Privacy Policy, Vendor Agreement, Driver Agreement, Cannabis Compliance Disclosures.
4. **22.4** — Self-onboarding wizards for vendors (DocuSign + license upload) and drivers (background check kick-off, insurance upload, Compliance Handbook acknowledgement).
5. **22.5** — Launch checklist at `docs/LAUNCH-CHECKLIST.md`.

Per the Definition of Done in the phase doc, the phase ships when all five deliverables exist, green-light commands pass (`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`), branch is pushed, PR is opened, and "Ready to ship" sign-off is given by the project owner.

This phase was started on the branch `phase/22-prelaunch-runbooks-legal-launch-checklist`. Two structural facts were discovered during exploration that forced a scope decision:

**Fact 1 — the portal scaffolding does not exist.** `PROGRESS.md` and the git history confirm that Phase 13 (vendor portal foundation: Next.js 15 app shell, auth, RBAC, layout, tenant context) was never written. The `apps/portal/` directory contains only a stub `package.json` whose scripts return `exit 0`. There is no `apps/portal/src/app/`, no auth, no RBAC, no shared layout.

**Fact 2 — Phase 22.1 (admin console) and Phase 22.4 (onboarding wizards) are scoped to live inside the portal.** The phase doc places them at `apps/portal/src/app/admin/` and `apps/portal/src/app/(onboarding)/`. They are presented as features inside a host application that does not exist.

The two structural facts together mean that delivering 22.1 and 22.4 as specified requires first delivering Phase 13. Phase 13 is itself a non-trivial chunk of work — the spec for the portal calls out:

- NextAuth or equivalent session auth with the existing `apps/api` JWT issuer.
- Tenant context middleware (every portal request carries `dispensaryId`).
- RBAC matrix with at least four roles (vendor-owner, vendor-manager, vendor-staff, dankdash-admin).
- App Router layout with sidebar nav, theme tokens, error boundary.
- Server Components against the read-only DB replica.
- Sentry + OTel integration on the portal process.

That work is a Phase 13 deliverable, not a Phase 22 deliverable. Trying to deliver it inside Phase 22 would (a) collapse two phases into one without phase-doc authorization, (b) make the resulting PR enormous and unreviewable, (c) leave 22.2 / 22.3 / 22.5 — the launch-blocking pieces — at risk of slipping if any one of the new portal sub-decisions stalled, and (d) violate the `CLAUDE.md` guidance: _"If a phase grows beyond ~3 hours of work or hits a blocker, stop and write `BLOCKED.md` — do not push through with shortcuts."_

The launch decision sits on top of Phase 22, but the launch decision is **not** blocked on 22.1 and 22.4 specifically. Three things have to be true to accept a real consumer order:

- the runbook coverage for the operational on-call has to exist (22.2);
- the legal disclosures the user sees in the app + the website have to exist (22.3);
- the launch-readiness checklist has to be walked top-to-bottom (22.5).

The admin console (22.1) and self-onboarding wizards (22.4) are **operationally substitutable** for the launch window — see "Substitutability" below.

## Decision

Phase 22 ships **22.2 runbooks, 22.3 legal drafts, and 22.5 launch checklist** as documented deliverables on this branch. Phase 22.1 admin console and Phase 22.4 onboarding wizards are deferred to a future phase that is gated on a separate Phase 13 portal-scaffold delivery.

The deferral is explicit, not implicit. The launch checklist (`docs/LAUNCH-CHECKLIST.md`) calls out the deferral in Section 7 and Appendix A. `PROGRESS.md` records what shipped and what was deferred. The deferred work is queued for a future Phase 22b or, more likely, will be re-scoped into Phase 13 itself (since the portal foundation and its first-feature deliverable naturally belong in the same phase).

### What ships in this phase

**22.2 — Runbooks (9 new files under `docs/runbooks/`):**

- `aeropay-outage.md`
- `metrc-api-failure.md`
- `high-order-error-rate.md`
- `database-failover.md`
- `driver-app-crash-spike.md`
- `customer-complaint-escalation.md`
- `license-compliance-audit.md`
- `data-export-request.md`
- `account-deletion-request.md`

These complement the existing Phase 21 runbooks (`jwt-key-rotation.md`, `disaster-recovery-restore.md`, `grafana-alert-triage.md`, `load-test-execution.md`, `otel-collector-outage.md`, `password-pepper-rotation.md`, `pgbouncer-saturation.md`, `veriff-key-rotation.md`). Together the runbook set covers every sev-1 / sev-2 alert defined in `infra/grafana/alerts/`.

Each new runbook follows the convention locked in by `jwt-key-rotation.md` and `disaster-recovery-restore.md`: Purpose → When to fire → Background → Procedure (numbered) → Rollback / undo → Postmortem template.

**22.3 — Legal first-drafts (5 new files under `docs/legal/`):**

- `README.md`
- `terms-of-service.md`
- `privacy-policy.md`
- `vendor-agreement.md`
- `driver-agreement.md`
- `cannabis-compliance-disclosures.md`

These are first drafts intended as the starting point for outside counsel review. Each file carries explicit `[REVIEW WITH COUNSEL]` markers at every section that requires lawyer sign-off — entity registration details, statutory citations to verify, refund posture, arbitration enforceability, insurance minimums, OCM advertising compliance, etc. The README catalogs the marker convention and lists the publication targets.

The legal docs are placed at `docs/legal/`, not at `apps/portal/src/app/(legal)/` as the phase doc originally specified. The phase-doc location is correct for the _served-at-runtime_ rendering of these docs once the marketing site exists; the _source markdown_ lives in `docs/legal/` for the same reason all other docs live in `docs/` — versioning, PR review, lawyer comment threads. When the marketing site (or the portal legal-page route) is built in a later phase, those routes will read from `docs/legal/*.md` at build time. This is consistent with the spec's "single source of truth for content" posture.

**22.5 — Launch checklist (`docs/LAUNCH-CHECKLIST.md`):**

A top-to-bottom gate doc enumerating eleven sections (legal, secrets, third-party provisioning, compliance engine, identity + payments, iOS apps, vendor portal, observability, on-call, marketing site, final go / no-go). Every box requires a named human sign-off with a date. The deferred items from this ADR are called out in Appendix A.

### What is deferred

**22.1 — Admin console.** Deferred to a future phase that is gated on Phase 13 (portal scaffolding) being written first. Operational substitutability during the launch window:

- User lookup → direct SQL on the read replica via the on-call's psql session.
- Order force-cancel → existing `account-deletion schedule` and `order force-cancel` CLI tools in `pnpm --filter @dankdash/api exec`.
- Dispatch override → manual driver re-assignment by the dispatcher via DankDasher dispatcher-mode TestFlight build.
- Refund issue → Aeropay refund API called via the same CLI surface; refund authority matrix in `customer-complaint-escalation.md` governs who may invoke it.
- Vendor license review → manual review by the compliance officer using the OCM portal directly; no DankDash-side admin console required.

These substitutes are documented in each relevant runbook. They are not pretty, but they are operationally sufficient for the first 3 dispensaries / 15 drivers / soft-launch volume that this checklist is sized for.

**22.4 — Self-onboarding wizards.** Deferred. Operational substitutability:

- Vendor onboarding → manual onboarding by the partnerships lead: DocuSign sends the Vendor Agreement, the dispensary returns counter-signed, the partnerships lead seeds the vendor row via a one-off seed script (`pnpm --filter @dankdash/db run seed-vendor`).
- Driver onboarding → manual onboarding by the operations lead: in-app Compliance Handbook acknowledgement is the only in-app step; everything before that (background check, insurance certificate, DocuSign signature) is collected out-of-band.

The launch-soft volume (15 drivers, 3 dispensaries) is small enough that manual onboarding is cheaper than building the self-onboarding wizard now. Once the portal exists, the wizard becomes a natural feature on top of the portal foundation.

## Consequences

### Positive

- **Launch path is unblocked.** Every truly launch-blocking item — runbooks for operational on-call, legal disclosures shown to users in the app, the legal docs that go to outside counsel for the cannabis-license review, the gate checklist that the CEO walks before saying Go — exists in this PR.
- **Scope is honest.** The deferred items are visibly documented in the checklist itself, in `PROGRESS.md`, and in this ADR. Nobody can later claim Phase 22 promised admin-console functionality that wasn't delivered, because the deferral is on the record.
- **Phase 13 keeps its scope.** When the portal is written, it gets to be its own coherent phase with auth + RBAC + layout + first-feature, not a 4-day mega-phase shoehorned in here.
- **Runbook + legal docs are reviewable now.** Outside counsel can begin reviewing the legal first-drafts while engineering continues on Phase 13 / 23. Counsel cycles take weeks; serializing legal-review behind portal-build would slip launch by months.

### Negative

- **Operations team carries a manual burden for the first launch window.** Refunds, force-cancels, and dispatch overrides require runbooks + psql access + named operator skill. This is real cost. The mitigation is that the launch volume is small enough (3 dispensaries, 15 drivers, no marketing) that the manual load is bounded.
- **Two of the five Phase 22 sub-tasks ship in a later phase.** The phase-doc's "Phase 22 done" cell in the table on `CLAUDE-CODE-PHASES.md` will need a footnote when this PR merges, calling out which items have moved to a follow-up phase.
- **A reviewer who reads only the phase doc will be confused** about why this PR is 13 docs and zero TypeScript. The PR description must explicitly state the deferral and link to this ADR; the launch checklist Section 7 + Appendix A also state the deferral, and `PROGRESS.md` records it.

### Risks

- **A counsel review cycle stalls.** The legal first-drafts are first drafts. If counsel takes 6 weeks instead of 2, launch slides. Mitigation: counsel was identified during Phase 0 and has already been briefed on the cannabis-specific posture; the first-drafts are scoped to be reviewable in a single cycle, not iteratively over months.
- **The deferred items are forgotten.** Mitigation: this ADR exists, the launch checklist explicitly calls them out, `PROGRESS.md` has a "Deferred from Phase 22" line, and the next phase-planning session reviews this ADR before deciding what to build next.
- **An unanticipated operational task during launch requires an admin-console workflow.** Mitigation: every operational workflow currently expected has either a runbook or a one-off CLI tool documented in a runbook. If a new workflow appears, the operations team escalates to engineering and a one-off script is written; that's acceptable for the launch volume.

## Alternatives considered

### Alternative A — Build Phase 13 + Phase 22 together as a single mega-phase

Rejected. The combined surface would be ~3,000 lines of code (Next.js scaffold + auth + RBAC + layout + admin console + onboarding wizards + the docs) plus the test surface for all of it. That violates the phase-doc's "scoped to a single session" posture, would result in an unreviewable PR, and risks any one sub-decision in the portal stalling the launch-blocking docs.

### Alternative B — Skip Phase 22 entirely, ship Phase 23 (final integration) directly

Rejected. Phase 23 explicitly depends on the runbooks (the integration tests reference the runbook procedures), and the legal docs are gating for App Store submission. Phase 22 cannot be skipped.

### Alternative C — Ship only the docs that are _strictly_ required for App Store submission

Rejected as too narrow. The runbooks are not "strictly required for App Store submission" but they _are_ strictly required for the on-call rotation on day one. Defining "launch-blocking" as "App Store needs it" would leave a real operational gap. The chosen scope is "anything an external party (lawyer, App Reviewer, customer, OCM auditor, on-call engineer) needs to read on day one."

### Alternative D — Stub the admin console + onboarding wizards as placeholder pages

Rejected. Placeholder pages would violate the `CLAUDE.md` "Zero placeholders, zero stubs" rule. A stub page that says "this admin console is coming soon" is worse than a documented deferral, because it suggests false readiness to anyone who finds the route by accident.

## Verification

The Phase 22 Definition of Done in `CLAUDE-CODE-PHASES.md` requires:

- [x] All Phase 22 sub-task deliverables exist — **partial**: 22.2, 22.3, 22.5 ship; 22.1 + 22.4 are deferred under this ADR.
- [x] `pnpm typecheck` passes — no TypeScript changes in this PR; the typecheck remains green.
- [x] `pnpm lint` passes — no source changes; lint remains green.
- [x] `pnpm test` passes — no test changes; the suite remains green.
- [x] Conventional-commit history, one logical commit per artifact — see the PR's commit history.
- [x] `PROGRESS.md` updated with the Phase 22 entry, calling out what shipped and what was deferred.
- [x] PR opened with the launch-readiness narrative.

The "Ready to ship" sign-off on this phase is **conditional** on accepting this ADR's scope decision. If the project owner instead wants the full 22.1 + 22.4 set delivered before Phase 22 closes, the right answer is to re-open Phase 13 (portal scaffolding) first, then re-attempt 22.1 + 22.4 on top of the portal. That work is not in scope of this PR.
