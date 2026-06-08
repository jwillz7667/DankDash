/**
 * Regression coverage for AnalyticsRepository's date-bound queries.
 *
 * The vendor-analytics service unit tests run against an in-memory fake repo,
 * so the *real* SQL these methods emit was never exercised in CI — which is
 * how a fatal bug shipped to prod: every method interpolated a raw JS `Date`
 * into its `WHERE delivered_at >= …` predicate, and postgres-js cannot encode
 * a bare Date as a bind parameter (`ERR_INVALID_ARG_TYPE: … Received an
 * instance of Date`), so `/v1/vendor/analytics/{sales,products}` returned 500
 * on every call. These tests run each method against a real Postgres so the
 * binding is genuinely executed.
 *
 * A non-existent dispensary id keeps results deterministically empty
 * regardless of what the shared container is seeded with — the point is that
 * the query *executes* (the bind path that used to throw), not the row math.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { AnalyticsRepository, newId } from '../../src/index.js';
import { getPool } from '../setup.js';

describe('AnalyticsRepository date binding', () => {
  let repo: AnalyticsRepository;
  // A ~30-day window with offset-bearing instants — the exact shape that 500'd
  // in prod (from/to are `Date` objects derived from ISO-8601 query params).
  const since = new Date('2026-05-08T00:00:00.000Z');
  const until = new Date('2026-06-07T00:00:00.000Z');
  // No fixtures: an unseeded dispensary yields empty aggregates everywhere.
  const dispensaryId = newId();

  beforeAll(() => {
    repo = new AnalyticsRepository(getPool().db);
  });

  it('dispensarySalesBetween executes with Date bounds and returns zeroed totals', async () => {
    await expect(repo.dispensarySalesBetween(dispensaryId, since, until)).resolves.toEqual({
      revenueCents: 0,
      orderCount: 0,
    });
  });

  it('dispensaryHourlyBetween executes with Date bounds and returns no buckets', async () => {
    await expect(repo.dispensaryHourlyBetween(dispensaryId, since, until)).resolves.toEqual([]);
  });

  it('dispensaryTopProductsBetween executes with Date bounds and returns no products', async () => {
    await expect(repo.dispensaryTopProductsBetween(dispensaryId, since, until)).resolves.toEqual(
      [],
    );
  });

  it('dispensaryReorderBetween executes with Date bounds and returns zeroed counts', async () => {
    await expect(repo.dispensaryReorderBetween(dispensaryId, since, until)).resolves.toEqual({
      customerCount: 0,
      repeatCustomerCount: 0,
    });
  });

  it('dispensaryDeadInventory executes with Date bounds and returns no listings', async () => {
    await expect(repo.dispensaryDeadInventory(dispensaryId, since, until)).resolves.toEqual([]);
  });
});
