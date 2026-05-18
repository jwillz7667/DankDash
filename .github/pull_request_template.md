<!--
Phase / area:
Spec section (docs/spec/...):
Linked issue:
-->

## Summary

<!-- 1-3 bullets describing what changed and why. -->

## Compliance impact

<!--
Required for any change touching cart, checkout, age gating, geofencing,
delivery handoff, beverage admission, Metrc reconciliation, or sale hours.
If the change does not affect compliance, write "None — touches only X/Y".
-->

## Test plan

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] New tests cover the new behavior (or rationale below)
- [ ] Compliance suite (`pnpm --filter @dankdash/compliance test`) — required for compliance touches
- [ ] Manual verification of the affected user flow (steps below)

### Manual verification

<!-- Steps a reviewer can repeat locally to validate the change. -->

## Rollout / rollback

<!--
- Feature flag (name + default)
- Migration order (if a DB change)
- Rollback plan if this breaks in staging
-->

## Screenshots / logs (optional)
