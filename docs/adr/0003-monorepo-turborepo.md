# ADR 0003 — Monorepo on Turborepo + pnpm workspaces

- **Status:** Accepted
- **Date:** 2026-05-17
- **Deciders:** Founding engineering (jwillz7667)
- **Supersedes:** —
- **Superseded by:** —

## Context

DankDash spans five TypeScript surfaces that all need to evolve in lockstep with one schema and one compliance engine:

- `apps/api` (NestJS), `apps/realtime` (Socket.io), `apps/workers` (BullMQ)
- `apps/portal` (Next.js vendor portal), `apps/checkout-web` (Next.js consumer checkout)
- Shared `packages/db`, `packages/compliance`, `packages/types`, `packages/config`, `packages/ui`, `packages/test-utils`

The two iOS apps live in the same git repo but stay as Xcode projects at the repo root rather than pnpm workspaces.

A type change in `packages/types` should propagate to every surface in one commit, with one CI run. A compliance fix in `packages/compliance` should be impossible to deploy without proving every consumer still builds. The Metrc client interface that the API and workers both import must be one type, not two.

We considered:

1. **Polyrepo** — one repo per app. Rejected: cross-cutting changes (a schema migration that touches three consumers) become a coordinated merge across three PRs across three repos, and the shared compliance package would need to be published as a private npm package on every change. Both add friction we cannot afford pre-launch.
2. **Nx** — capable but heavier conceptually (generators, computation graphs, plugin ecosystem). Turborepo's smaller surface area is a better fit for a team this size.
3. **pnpm workspaces alone, no orchestrator** — works, but pipelines like "typecheck everything that depends on `@dankdash/types`" become hand-written shell scripts. Turbo gives us topological pipelines and remote caching for free.

## Decision

The repo root is a **Turborepo** with **pnpm workspaces**.

- `pnpm-workspace.yaml` declares `apps/*` and `packages/*` as workspaces.
- `turbo.json` defines the pipelines (`build`, `dev`, `lint`, `typecheck`, `test`, `test:integration`, `clean`) with `dependsOn: ["^build"]` where appropriate so packages compile in topological order.
- Every package extends `packages/config/tsconfig.base.json` and uses TypeScript project references — `tsc --build` walks the graph correctly.
- Shared dev tooling (ESLint flat config, Prettier, commitlint, lint-staged) is hoisted at the repo root so there is one source of truth.
- Turbo cache is filesystem-local by default, with optional remote cache via `TURBO_TOKEN` + `TURBO_TEAM` in CI (off by default; on once we have the cost signal to justify it).
- The two iOS apps (`DankDash/` consumer, `DankDasher/` driver) are **not** workspaces. They are Xcode projects under git source control alongside the monorepo, and have their own build commands. This is intentional — pnpm has nothing to offer Xcode.

## Consequences

**Positive**

- A change to a shared package and all its consumers ships in one PR with one green CI run. No version-pin dance.
- `pnpm install` from a fresh clone hydrates everything. The phase-0 dev loop is `pnpm install && docker compose up -d && pnpm dev`.
- Turbo cache shortens incremental CI by skipping packages whose inputs haven't changed.
- Strict TypeScript project references catch missing exports across package boundaries at compile time, not runtime.

**Negative**

- A `pnpm install` failure or a workspace misconfiguration can break every app at once. Mitigated by keeping the install step the first job in CI and by exercising it from a clean clone in the Phase 0 verification step.
- Pulling the whole repo is heavier than pulling one app. Acceptable; we do not have a strong sparse-checkout requirement at this scale.

**Neutral**

- The iOS apps are versioned in the same git history but with different release cadences (App Store submission vs. Railway deploy). The phase plan accounts for this — iOS phases (12, 14, 19, 20, 21) are scoped separately from backend phases.

## Revisit triggers

- A backend team and a portal team end up needing independent CI cadences — at that point Nx Cloud or a polyrepo extraction becomes worth the cost.
- pnpm or Turbo drops a feature we depend on (no current risk).
