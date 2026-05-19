/**
 * Socket.io Redis adapter wiring.
 *
 * The redis adapter uses two ioredis instances: one for publishing room
 * broadcasts, one in subscribe mode for receiving them. Sharing a single
 * client between the two would block the connection on the SUBSCRIBE
 * command — ioredis enforces a strict "either pub or sub" model per
 * client, same as the underlying Redis protocol.
 *
 * The adapter is what makes multi-pod scaling work: `io.of('/customer').
 * to('user:abc').emit(...)` published from pod A finds its way to a
 * websocket connected to pod B because pod B's adapter is subscribed
 * to the broadcast channel.
 *
 * `getKeyPrefix` is exported so tests can use a unique prefix per run
 * and avoid cross-talk between concurrent suites pointing at the same
 * test Redis (containers are shared, prefixes are not).
 */
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';

export interface RedisAdapterClients {
  readonly pubClient: Redis;
  readonly subClient: Redis;
}

export interface RedisAdapterOptions {
  readonly redisUrl: string;
  readonly keyPrefix?: string;
}

export function createRedisAdapterClients(options: RedisAdapterOptions): RedisAdapterClients {
  const prefix = options.keyPrefix ?? 'dankdash:io';
  // maxRetriesPerRequest bounded so a Redis blip surfaces as a fast error
  // rather than queuing forever. The adapter's own reconnect logic handles
  // the longer-term recovery.
  const pubClient = new Redis(options.redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    keyPrefix: `${prefix}:`,
  });
  const subClient = pubClient.duplicate();
  return { pubClient, subClient };
}

export function createRedisIoAdapter(
  clients: RedisAdapterClients,
): ReturnType<typeof createAdapter> {
  // requestsTimeout is the upper bound on cross-pod request/response
  // calls like socketsJoin — keep it short so a wedged pod cannot stall
  // the issuing pod.
  return createAdapter(clients.pubClient, clients.subClient, { requestsTimeout: 5_000 });
}

export async function closeRedisAdapter(clients: RedisAdapterClients): Promise<void> {
  // Order matters: stop publishing first, then sever the subscriber.
  // Otherwise a final XADD-driven broadcast could publish to a closed
  // sub client and surface as a noisy ECONNRESET in logs.
  await safeQuit(clients.pubClient);
  await safeQuit(clients.subClient);
}

async function safeQuit(client: Redis): Promise<void> {
  if (client.status === 'end' || client.status === 'wait') return;
  await client.quit().catch(() => undefined);
}
