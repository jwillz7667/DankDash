/**
 * Per-suite test harness for apps/realtime.
 *
 * One `createTestHarness()` call per test or `beforeEach` boots a fresh
 * Socket.io server on an ephemeral port, connects to the shared Redis
 * testcontainer (REDIS_TEST_URL is set by global-setup), wires an
 * in-memory MembershipRepository, and exposes:
 *
 *   - `signToken({...})` to mint RS256 tokens that the server's
 *     RealtimeJwtVerifier accepts.
 *   - `connect(namespace, token, extraAuth?)` to open a socket.io-client.
 *   - `publishEnvelope(...)` to drop an event onto the realtime stream
 *     (the server's StreamConsumer reads it and broadcasts).
 *   - `close()` to shut everything down (HTTP, Socket.io, Redis clients).
 *
 * Every harness uses a unique consumer-group name (`realtime-test-<rand>`)
 * so concurrent specs do not steal each other's XREADGROUP entries.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createLogger } from '@dankdash/config';
import { publishRealtimeEvent, type RealtimeEvent } from '@dankdash/realtime-events';
import { ConfigError } from '@dankdash/types';
import { Redis } from 'ioredis';
import jwt from 'jsonwebtoken';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { uuidv7 } from 'uuidv7';
import { loadRealtimeEnv, type RealtimeEnv } from '../src/env.js';
import { buildServer, type RealtimeServer } from '../src/server.js';
import type { MembershipRepository } from '../src/membership/repo.js';

const TOKEN_ISSUER = 'dankdash';
const TOKEN_AUDIENCE = 'dankdash.app';

export interface SignTokenInput {
  readonly sub: string;
  readonly role: string;
  readonly sid?: string;
  /** Seconds until expiry (default 600). Use negative to mint an expired token. */
  readonly ttlSeconds?: number;
  /** Override iss for negative-path tests (e.g. wrong-issuer rejection). */
  readonly issuer?: string;
  /** Override aud similarly. */
  readonly audience?: string;
}

export interface ConnectOptions {
  readonly token?: string;
  readonly extraAuth?: Record<string, unknown>;
  /** Default 3s — connection should succeed or `connect_error` quickly. */
  readonly timeoutMs?: number;
}

export interface TestHarness {
  readonly server: RealtimeServer;
  readonly port: number;
  readonly redisUrl: string;
  readonly membership: InMemoryMembershipRepository;
  readonly publisher: Redis;
  signToken(input: SignTokenInput): string;
  connect(
    namespace: '/customer' | '/vendor' | '/driver',
    opts: ConnectOptions,
  ): Promise<ClientSocket>;
  publishEnvelope(event: RealtimeEvent): Promise<string>;
  close(): Promise<void>;
}

/**
 * In-memory MembershipRepository. Mirrors the Drizzle implementation's
 * contract — tests register staff/drivers via the mutator methods and
 * the namespace middleware reads through the same async API the
 * Postgres-backed repo exposes.
 */
export class InMemoryMembershipRepository implements MembershipRepository {
  private readonly staff = new Map<string, Set<string>>();
  private readonly drivers = new Map<string, string>();

  addStaff(userId: string, dispensaryId: string): void {
    const set = this.staff.get(userId) ?? new Set<string>();
    set.add(dispensaryId);
    this.staff.set(userId, set);
  }

  addDriver(userId: string, driverId: string): void {
    this.drivers.set(driverId, userId);
  }

  isStaffOfDispensary(userId: string, dispensaryId: string): Promise<boolean> {
    return Promise.resolve(this.staff.get(userId)?.has(dispensaryId) ?? false);
  }

  listStaffDispensariesForUser(userId: string): Promise<string[]> {
    return Promise.resolve(Array.from(this.staff.get(userId) ?? []));
  }

  isDriver(userId: string, driverId: string): Promise<boolean> {
    return Promise.resolve(this.drivers.get(driverId) === userId);
  }

  findDriverIdForUser(userId: string): Promise<string | null> {
    for (const [driverId, ownerUserId] of this.drivers.entries()) {
      if (ownerUserId === userId) return Promise.resolve(driverId);
    }
    return Promise.resolve(null);
  }
}

export async function createTestHarness(): Promise<TestHarness> {
  const redisUrl = process.env['REDIS_TEST_URL'];
  if (redisUrl === undefined) {
    throw new ConfigError('CONFIG_MISSING', 'REDIS_TEST_URL not set — globalSetup did not run');
  }

  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const consumerGroup = `realtime-test-${randomBytes(6).toString('hex')}`;

  const env: RealtimeEnv = loadRealtimeEnv({
    source: {
      ...process.env,
      DATABASE_URL: 'postgres://test:test@127.0.0.1/test',
      REDIS_URL: redisUrl,
      JWT_PUBLIC_KEY_BASE64: Buffer.from(publicKey).toString('base64'),
      REALTIME_CONSUMER_GROUP: consumerGroup,
      // Short bucket so rate-limit tests do not have to sleep a full
      // second between attempts.
      DRIVER_LOCATION_BURST: '2',
      DRIVER_LOCATION_RATE_PER_SECOND: '1',
      LOG_LEVEL: process.env['REALTIME_TEST_LOG'] ?? 'fatal',
    },
  });

  const logger = createLogger({
    name: 'apps/realtime/test',
    level: process.env['REALTIME_TEST_LOG'] ?? 'fatal',
    environment: 'test',
  });

  const membership = new InMemoryMembershipRepository();
  const server = await buildServer({ env, logger, membership });
  await server.listen(0);

  const address = server.httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new ConfigError(
      'CONFIG_INVALID',
      'httpServer not listening on a TCP socket after listen(0)',
    );
  }
  const port = address.port;

  const publisher = new Redis(redisUrl, { maxRetriesPerRequest: 1 });

  const clients = new Set<ClientSocket>();

  return {
    server,
    port,
    redisUrl,
    membership,
    publisher,
    signToken(input) {
      const sid = input.sid ?? uuidv7();
      const ttl = input.ttlSeconds ?? 600;
      return jwt.sign({ sid, role: input.role }, privateKey, {
        algorithm: 'RS256',
        subject: input.sub,
        issuer: input.issuer ?? TOKEN_ISSUER,
        audience: input.audience ?? TOKEN_AUDIENCE,
        keyid: 'test',
        expiresIn: ttl,
      });
    },
    async connect(namespace, opts) {
      const url = `http://127.0.0.1:${String(port)}${namespace}`;
      const client = ioClient(url, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        auth: {
          ...(opts.token !== undefined ? { token: opts.token } : {}),
          ...opts.extraAuth,
        },
      });
      clients.add(client);
      const timeoutMs = opts.timeoutMs ?? 3_000;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          client.off('connect', onConnect);
          client.off('connect_error', onError);
          reject(new Error(`connect timeout after ${String(timeoutMs)}ms`));
        }, timeoutMs);
        const onConnect = (): void => {
          clearTimeout(timer);
          client.off('connect_error', onError);
          resolve();
        };
        const onError = (err: Error): void => {
          clearTimeout(timer);
          client.off('connect', onConnect);
          reject(err);
        };
        client.once('connect', onConnect);
        client.once('connect_error', onError);
      });
      return client;
    },
    publishEnvelope(event) {
      return publishRealtimeEvent(publisher, {
        id: uuidv7(),
        emittedAt: new Date().toISOString(),
        source: 'api',
        event,
      });
    },
    async close() {
      for (const client of clients) {
        client.removeAllListeners();
        client.disconnect();
      }
      clients.clear();
      await server.close();
      publisher.disconnect();
    },
  };
}

/** Polls until `predicate()` returns true (or resolves true) or the deadline passes. */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 3_000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new ConfigError(
    'CONFIG_INVALID',
    `waitUntil timed out${options.label !== undefined ? `: ${options.label}` : ''}`,
  );
}

/** Resolves on the next matching socket.io event or rejects on timeout. */
export function expectEvent<T = unknown>(
  socket: ClientSocket,
  eventName: string,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 3_000;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, handler);
      reject(new Error(`event "${eventName}" not received within ${String(timeoutMs)}ms`));
    }, timeoutMs);
    const handler = (payload: T): void => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(eventName, handler);
  });
}
