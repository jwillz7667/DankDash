/**
 * Drizzle infrastructure module.
 *
 * Owns the lifecycle of a single Postgres connection pool for the whole API
 * process. Exposes two injection tokens:
 *
 *   DRIZZLE_POOL — the Pool instance (includes the typed `db`, raw `sql`,
 *                   and `timed()` helper).
 *   DRIZZLE_DB   — the typed Database object, the most common dependency
 *                   for repositories and services.
 *
 * The module is `@Global()` so feature modules don't have to re-declare the
 * provider; it boots once at app init and tears down on SIGTERM through
 * `app.enableShutdownHooks()`.
 *
 * The factory re-validates env via `loadEnv()` rather than narrowing
 * `ConfigService` results manually — loadEnv is fast, idempotent, and is
 * the single source of truth for the typed Env shape.
 */
import { loadEnv } from '@dankdash/config';
import { createPoolFromEnv, type Database, type Pool } from '@dankdash/db';
import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type FactoryProvider,
} from '@nestjs/common';
import { resolveLogger } from './logger.js';

export const DRIZZLE_POOL = Symbol.for('DRIZZLE_POOL');
export const DRIZZLE_DB = Symbol.for('DRIZZLE_DB');

const poolProvider: FactoryProvider<Pool> = {
  provide: DRIZZLE_POOL,
  inject: [],
  useFactory: (): Pool => {
    const env = loadEnv();
    return createPoolFromEnv(env, resolveLogger(env));
  },
};

const dbProvider: FactoryProvider<Database> = {
  provide: DRIZZLE_DB,
  inject: [DRIZZLE_POOL],
  useFactory: (pool: Pool): Database => pool.db,
};

@Injectable()
class DrizzlePoolShutdown implements OnApplicationShutdown {
  constructor(@Inject(DRIZZLE_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.close();
  }
}

@Global()
@Module({
  providers: [poolProvider, dbProvider, DrizzlePoolShutdown],
  exports: [DRIZZLE_POOL, DRIZZLE_DB],
})
export class DrizzleModule {}
