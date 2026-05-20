/**
 * Redis-backed dedup store for the notification dispatcher.
 *
 * Wraps `SET key value EX ttl NX` so an already-dispatched (userId,
 * templateKey, eventId) tuple cannot fan out twice. The dispatcher
 * acquires the key BEFORE rendering + sending; failure to acquire is
 * the signal that some other process — or this same process replaying
 * a duplicate event — already sent the bundle.
 *
 * TTL is 24h per spec §5.2 (the "idempotency window" for retries from
 * the order machine + webhook bus). After 24h the key expires and a
 * fresh send is allowed; in practice that only matters for the
 * payment.failed → retry-the-charge path, where we DO want a second
 * notification if the user lets the original lapse for a day.
 *
 * The interface is abstracted so test composition can swap in an
 * in-memory implementation without touching Redis. Production wiring
 * (`notifications.module.ts`) supplies the Redis variant.
 */
import type { Redis } from 'ioredis';

export interface NotificationDedupeStore {
  /**
   * Atomic SETNX with TTL. Returns true iff this call acquired the key
   * (i.e., it was not already set). False indicates a previous dispatch
   * already happened — the caller must skip sending.
   */
  acquire(key: string, ttlSeconds: number): Promise<boolean>;
}

export class RedisNotificationDedupeStore implements NotificationDedupeStore {
  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix = 'notif:dedupe:',
  ) {}

  async acquire(key: string, ttlSeconds: number): Promise<boolean> {
    // ioredis returns 'OK' on success, null when NX rejected the write.
    // The four-arg form `SET key value EX ttl NX` is the atomic op we
    // need — anything that splits SET + EXPIRE risks orphaned keys on a
    // mid-flight crash. EX seconds (not PX ms) keeps the key visible in
    // any Redis dashboard with second precision, which is the granularity
    // ops actually inspects.
    const result = await this.redis.set(`${this.keyPrefix}${key}`, '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }
}
