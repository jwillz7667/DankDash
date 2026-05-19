import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration.
 *
 * We do NOT run `drizzle-kit push` against any environment — migrations are
 * the source of truth. `drizzle-kit generate` is available for future
 * migrations, but the initial `0000_init.sql` is hand-written because it
 * requires PostGIS extension creation, trigger functions, partitioning,
 * and RLS policies that drizzle-kit cannot express today.
 */
export default defineConfig({
  schema: './src/schema/index.ts',
  out: './src/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://localhost/dankdash',
  },
  strict: true,
  verbose: true,
});
