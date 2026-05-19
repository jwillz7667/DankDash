/**
 * Redis infrastructure module.
 *
 * Owns the lifecycle of a single ioredis client for the whole API process.
 * Exposed under the REDIS_CLIENT injection token. The rate-limit store and
 * any future cache / pub-sub features depend on this singleton so we never
 * fan out connection counts unnecessarily — Railway's Redis plan caps at
 * a few hundred concurrent clients and connection bloat is a real risk.
 *
 * `@Global` so feature modules pull it in via Inject() without having to
 * re-import RedisModule. Shutdown closes the connection cleanly on
 * SIGTERM via OnApplicationShutdown — without it, Node sometimes lingers
 * for the keep-alive ping cycle and Railway terminates with SIGKILL.
 *
 * The factory honors NODE_ENV=test by enabling `lazyConnect` and
 * `maxRetriesPerRequest=0`. Tests should never hit a real Redis; they
 * use the MemoryRateLimitStore implementation. If a test does pull a
 * dependency that depends on REDIS_CLIENT, the client is constructed but
 * never connects until something tries to use it — failing loud rather
 * than silently masking the misuse.
 */
import { loadEnv } from '@dankdash/config';
import {
  Global,
  Inject,
  Injectable,
  Module,
  type FactoryProvider,
  type OnApplicationShutdown,
} from '@nestjs/common';
// Named import: `Redis` is both the class value and the instance type. The
// default import points at the namespace, which TS cannot use in type
// position — leading to "Cannot use namespace 'Redis' as a type". See
// https://github.com/redis/ioredis/blob/main/lib/index.ts.
import { Redis, type RedisOptions } from 'ioredis';

export const REDIS_CLIENT = Symbol.for('REDIS_CLIENT');

export type RedisClient = Redis;

const redisProvider: FactoryProvider<Redis> = {
  provide: REDIS_CLIENT,
  inject: [],
  useFactory: (): Redis => {
    const env = loadEnv();
    const isTest = env.NODE_ENV === 'test';
    const options: RedisOptions = {
      lazyConnect: isTest,
      // Bounding retries keeps a misconfigured prod boot loud — Fastify
      // will fail health checks rather than queue commands indefinitely
      // against an unreachable Redis. The default is 20.
      maxRetriesPerRequest: isTest ? 0 : 3,
      enableReadyCheck: !isTest,
    };
    return new Redis(env.REDIS_URL, options);
  },
};

@Injectable()
class RedisShutdown implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    // quit() drains in-flight commands and sends QUIT — preferred over
    // disconnect() which severs the socket mid-command. If the client
    // never connected (lazyConnect in tests) status is 'wait' and quit
    // throws; ignore that path.
    if (this.client.status === 'wait' || this.client.status === 'end') return;
    await this.client.quit().catch(() => undefined);
  }
}

@Global()
@Module({
  providers: [redisProvider, RedisShutdown],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
