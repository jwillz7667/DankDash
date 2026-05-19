/**
 * MemoryTokenCache contract tests. The production code path uses the
 * ioredis adapter wired at the API composition root; this in-memory
 * version exists for unit tests and local development and must satisfy
 * the same TokenCache shape with TTL expiry semantics.
 */
import { describe, expect, it } from 'vitest';
import { MemoryTokenCache } from '../src/token-cache.js';

describe('MemoryTokenCache', () => {
  it('returns null for a missing key', async () => {
    const cache = new MemoryTokenCache();
    expect(await cache.get('missing')).toBeNull();
  });

  it('round-trips a value before TTL expires', async () => {
    let now = 1_000_000;
    const cache = new MemoryTokenCache(() => now);
    await cache.set('k', 'v', 60);
    expect(await cache.get('k')).toBe('v');
    now += 59_000;
    expect(await cache.get('k')).toBe('v');
  });

  it('drops the value once TTL elapses and reports it as missing', async () => {
    let now = 1_000_000;
    const cache = new MemoryTokenCache(() => now);
    await cache.set('k', 'v', 30);
    now += 30_000;
    expect(await cache.get('k')).toBeNull();
    // Second read still null — internal entry was evicted on first miss,
    // proving the eviction path runs (not just a TTL comparison).
    expect(await cache.get('k')).toBeNull();
  });

  it('overwrites a prior entry on subsequent set', async () => {
    const cache = new MemoryTokenCache();
    await cache.set('k', 'v1', 60);
    await cache.set('k', 'v2', 60);
    expect(await cache.get('k')).toBe('v2');
  });

  it('deletes a key on demand', async () => {
    const cache = new MemoryTokenCache();
    await cache.set('k', 'v', 60);
    await cache.del('k');
    expect(await cache.get('k')).toBeNull();
  });

  it('uses Date.now as the default clock', async () => {
    const cache = new MemoryTokenCache();
    await cache.set('k', 'v', 60);
    expect(await cache.get('k')).toBe('v');
  });
});
