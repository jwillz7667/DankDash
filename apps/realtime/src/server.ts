/**
 * Realtime server composition root.
 *
 * Builds the full runtime graph (HTTP server, Socket.io engine, Redis
 * adapter, JWT verifier, membership repo, stream consumer) and returns a
 * handle the entrypoint can listen + shut down. Pure factory — no
 * side-effects on import, no global singletons, so the integration tests
 * can spin up a fresh server per suite against the test Redis container.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { ConfigError } from '@dankdash/types';
import express, { type Application } from 'express';
import { Redis } from 'ioredis';
import { Server as IoServer } from 'socket.io';
import { decodePublicKey, RealtimeJwtVerifier } from './auth/jwt.js';
import { createHealthRouter } from './http/health.js';
import { registerCustomerNamespace } from './io/namespaces/customer.js';
import { registerDriverNamespace } from './io/namespaces/driver.js';
import { registerVendorNamespace } from './io/namespaces/vendor.js';
import {
  closeRedisAdapter,
  createRedisAdapterClients,
  createRedisIoAdapter,
  type RedisAdapterClients,
} from './io/redis-adapter.js';
import { DrizzleMembershipRepository, type MembershipRepository } from './membership/repo.js';
import { StreamConsumer } from './streams/consumer.js';
import type { RealtimeEnv } from './env.js';
import type { Logger } from '@dankdash/config';
import type { Pool } from '@dankdash/db';

export interface BuildServerOptions {
  readonly env: RealtimeEnv;
  /**
   * Postgres pool used for the default membership repository. Optional
   * when a custom `membership` is injected — production wires the real
   * pool, tests omit it and pass an in-memory membership instead.
   */
  readonly pool?: Pool;
  readonly logger: Logger;
  /**
   * Optional override for the Redis adapter clients — tests pass in
   * pre-built clients pointing at the test Redis container so the
   * adapter does not need to know about REDIS_URL.
   */
  readonly adapterClients?: RedisAdapterClients;
  /**
   * Optional override for the stream client. The adapter clients carry a
   * `dankdash:io:` keyPrefix that the Socket.io adapter uses for its own
   * pub/sub channels — sharing that client for the application stream
   * would prefix `dankdash:realtime` and silently break interop with the
   * API / workers that publish to the unprefixed key. So we use a
   * separate client for XADD/XREADGROUP.
   */
  readonly streamClient?: Redis;
  /**
   * Optional override for the membership repository. Tests inject an
   * in-memory implementation so the realtime suite can run against a
   * Redis container alone (no Postgres required).
   */
  readonly membership?: MembershipRepository;
}

export interface RealtimeServer {
  readonly app: Application;
  readonly httpServer: HttpServer;
  readonly io: IoServer;
  readonly listen: (port: number) => Promise<void>;
  readonly close: () => Promise<void>;
}

export async function buildServer(options: BuildServerOptions): Promise<RealtimeServer> {
  const app: Application = express();
  const verifier = new RealtimeJwtVerifier({
    publicKeyPem: decodePublicKey(options.env.JWT_PUBLIC_KEY_BASE64),
  });
  const adapterClients =
    options.adapterClients ?? createRedisAdapterClients({ redisUrl: options.env.REDIS_URL });
  const streamClient =
    options.streamClient ??
    new Redis(options.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
  // The consumer's XREADGROUP BLOCK <ms> holds the ioredis connection for
  // the full block duration; sharing the producer's streamClient would
  // deadlock its XADDs behind a 5s block. Keep the consumer on a
  // dedicated connection (always owned by buildServer — we never accept
  // an injected one because the producer-vs-consumer distinction is an
  // internal invariant).
  const consumerClient = streamClient.duplicate();

  app.use(createHealthRouter({ redis: streamClient }));

  const httpServer = createServer(app);
  const io = new IoServer(httpServer, {
    pingInterval: options.env.SOCKET_PING_INTERVAL_MS,
    pingTimeout: options.env.SOCKET_PING_TIMEOUT_MS,
    cors: buildCorsConfig(options.env),
    serveClient: false, // we do not serve the legacy /socket.io.js client
    adapter: createRedisIoAdapter(adapterClients),
  });

  const membership = resolveMembership(options);
  registerCustomerNamespace(io.of('/customer'), {
    verifier,
    logger: options.logger,
  });
  registerVendorNamespace(io.of('/vendor'), {
    verifier,
    membership,
    logger: options.logger,
  });
  registerDriverNamespace(io.of('/driver'), {
    verifier,
    membership,
    redis: streamClient,
    logger: options.logger,
    rateLimit: {
      capacity: options.env.DRIVER_LOCATION_BURST,
      refillPerSecond: options.env.DRIVER_LOCATION_RATE_PER_SECOND,
    },
  });

  const consumer = new StreamConsumer({
    redis: consumerClient,
    io,
    logger: options.logger,
    group: options.env.REALTIME_CONSUMER_GROUP,
    ...(options.env.REALTIME_CONSUMER_NAME !== undefined
      ? { consumerName: options.env.REALTIME_CONSUMER_NAME }
      : {}),
  });
  await consumer.ensureGroup();
  consumer.start();

  async function listen(port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        httpServer.off('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        httpServer.off('error', onError);
        resolve();
      };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(port, '0.0.0.0');
    });
  }

  async function close(): Promise<void> {
    await consumer.stop();
    // io.close() also closes the underlying httpServer that engine.io
    // attached to, so calling httpServer.close() afterwards raises
    // ERR_SERVER_NOT_RUNNING. Only fall back to a direct close if the
    // server is still listening (e.g. close() called before any
    // socket.io machinery wired up — defensive, should not happen).
    await new Promise<void>((resolve) => {
      void io.close(() => {
        resolve();
      });
    });
    if (httpServer.listening) {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err !== undefined) reject(err);
          else resolve();
        });
      });
    }
    if (options.adapterClients === undefined) {
      await closeRedisAdapter(adapterClients);
    }
    if (consumerClient.status !== 'end' && consumerClient.status !== 'wait') {
      await consumerClient.quit().catch(() => undefined);
    }
    if (options.streamClient === undefined) {
      if (streamClient.status !== 'end' && streamClient.status !== 'wait') {
        await streamClient.quit().catch(() => undefined);
      }
    }
  }

  return { app, httpServer, io, listen, close };
}

function resolveMembership(options: BuildServerOptions): MembershipRepository {
  if (options.membership !== undefined) return options.membership;
  if (options.pool === undefined) {
    throw new ConfigError(
      'CONFIG_MISSING',
      'buildServer requires either `pool` or `membership` to resolve the membership repository',
    );
  }
  return new DrizzleMembershipRepository(options.pool.db);
}

function buildCorsConfig(env: RealtimeEnv): { origin: string[] | true } {
  if (env.SOCKET_CORS_ORIGINS.trim().length === 0) {
    // Same-origin only. Socket.io interprets `true` here as "reflect
    // the request's Origin header" which is what mobile clients send
    // as a literal app scheme — never a browser-style cross-site
    // request. Production browser origins (vendor portal) are
    // explicitly listed via SOCKET_CORS_ORIGINS.
    return { origin: true };
  }
  return {
    origin: env.SOCKET_CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0),
  };
}
