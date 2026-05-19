/**
 * Programmatic migration runner.
 *
 * We hand-roll this instead of using `drizzle-kit migrate` because:
 *   - We need `pg_try_advisory_lock` to serialize concurrent runners during
 *     Railway deploys (multiple replicas booting at once).
 *   - We track per-file SHA-256 to surface "applied migration was edited
 *     after the fact" drift before it corrupts staging.
 *   - We want a deterministic rollback path (`*.down.sql`) that drizzle-kit
 *     does not generate.
 *
 * The journal at `migrations/meta/_journal.json` is still produced by
 * drizzle-kit and remains the source of order/tagging.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import type { Logger } from 'pino';

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';
const MIGRATIONS_TABLE = 'dankdash_schema_migrations';

/**
 * Stable cluster-wide mutex key, passed to pg_try_advisory_lock(bigint).
 * Derived once from sha256('dankdash:migrations') truncated to a JS-safe
 * integer; never rotated, because changing it would let two runners hold
 * "different" locks and stampede the same database.
 */
const ADVISORY_LOCK_KEY = 4_398_046_511_104;

export interface MigrationOptions {
  readonly databaseUrl: string;
  readonly migrationsDir: string;
  readonly logger: Logger;
}

export interface StatusOptions {
  readonly databaseUrl: string;
  readonly migrationsDir: string;
}

export interface AppliedMigration {
  readonly tag: string;
  readonly runtimeMs: number;
}

export interface MigrationStatusEntry {
  readonly idx: number;
  readonly tag: string;
  readonly state: 'applied' | 'pending';
  readonly fileSha256: string;
  readonly appliedSha256: string | null;
  readonly appliedAt: Date | null;
  readonly runtimeMs: number | null;
  readonly driftDetected: boolean;
}

interface JournalEntry {
  readonly idx: number;
  readonly version: string;
  readonly when: number;
  readonly tag: string;
  readonly breakpoints: boolean;
}

interface Journal {
  readonly version: string;
  readonly dialect: string;
  readonly entries: readonly JournalEntry[];
}

interface AppliedRow {
  readonly idx: number;
  readonly tag: string;
  readonly sha256: string;
  readonly applied_at: Date;
  readonly runtime_ms: number;
}

export class MigrationLockBusyError extends Error {
  public override readonly name = 'MigrationLockBusyError';
  constructor() {
    super('Another migration runner holds the advisory lock; refusing to proceed.');
  }
}

export class MigrationDriftError extends Error {
  public override readonly name = 'MigrationDriftError';
  constructor(tag: string, recorded: string, actual: string) {
    super(
      `Migration "${tag}" content drift detected. ` +
        `Recorded sha256=${recorded.slice(0, 12)}… actual=${actual.slice(0, 12)}…. ` +
        `Applied migrations are immutable — create a new migration to amend.`,
    );
  }
}

export class MigrationDownNotDefinedError extends Error {
  public override readonly name = 'MigrationDownNotDefinedError';
  constructor(tag: string) {
    super(`Migration "${tag}" has no .down.sql companion; rollback is not defined.`);
  }
}

export class MigrationFileMissingError extends Error {
  public override readonly name = 'MigrationFileMissingError';
  constructor(tag: string) {
    super(`Migration file ${tag}.sql is listed in _journal.json but not on disk.`);
  }
}

export class MigrationJournalMismatchError extends Error {
  public override readonly name = 'MigrationJournalMismatchError';
  constructor(idx: number, tag: string) {
    super(
      `Applied migration idx=${idx} tag=${tag} has no entry in _journal.json; ` +
        `journal and database have diverged.`,
    );
  }
}

/**
 * Resolve the canonical migrations directory relative to this module.
 * Compiled output keeps the same layout (`dist/migrate.js` ↔ `dist/migrations/`),
 * so the same code works from `src/` via tsx and from `dist/` via node.
 */
export function defaultMigrationsDir(moduleUrl: string): string {
  return join(dirname(fileURLToPath(moduleUrl)), 'migrations');
}

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function splitStatements(sql: string, hasBreakpoints: boolean): readonly string[] {
  if (!hasBreakpoints) {
    const single = sql.trim();
    return single.length > 0 ? [single] : [];
  }
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

async function readJournal(migrationsDir: string): Promise<Journal> {
  const raw = await readFile(join(migrationsDir, 'meta', '_journal.json'), 'utf8');
  const parsed = JSON.parse(raw) as Journal;
  return {
    ...parsed,
    entries: [...parsed.entries].sort((a, b) => a.idx - b.idx),
  };
}

async function readMigrationFile(
  migrationsDir: string,
  tag: string,
  direction: 'up' | 'down',
): Promise<string | null> {
  const suffix = direction === 'up' ? '.sql' : '.down.sql';
  try {
    return await readFile(join(migrationsDir, `${tag}${suffix}`), 'utf8');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return null;
    throw error;
  }
}

function makeConnection(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    max: 1,
    prepare: false,
    onnotice: () => {
      /* swallow "already exists" notices from IF NOT EXISTS DDL */
    },
  });
}

async function ensureMigrationsTable(sql: Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      idx        integer PRIMARY KEY,
      tag        text NOT NULL UNIQUE,
      sha256     text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      runtime_ms integer NOT NULL
    );
  `);
}

async function withAdvisoryLock<T>(sql: Sql, fn: () => Promise<T>): Promise<T> {
  const rows = await sql<{ acquired: boolean }[]>`
    SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) AS acquired
  `;
  const acquired = rows[0]?.acquired ?? false;
  if (!acquired) throw new MigrationLockBusyError();
  try {
    return await fn();
  } finally {
    await sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
  }
}

async function fetchApplied(sql: Sql): Promise<readonly AppliedRow[]> {
  return sql<AppliedRow[]>`
    SELECT idx, tag, sha256, applied_at, runtime_ms
    FROM ${sql(MIGRATIONS_TABLE)}
    ORDER BY idx ASC
  `;
}

export async function runMigrations(opts: MigrationOptions): Promise<readonly AppliedMigration[]> {
  const { databaseUrl, migrationsDir, logger } = opts;
  const sql = makeConnection(databaseUrl);
  const applied: AppliedMigration[] = [];

  try {
    await ensureMigrationsTable(sql);
    const journal = await readJournal(migrationsDir);

    await withAdvisoryLock(sql, async () => {
      const appliedRows = await fetchApplied(sql);
      const appliedByIdx = new Map(appliedRows.map((row) => [row.idx, row]));

      for (const entry of journal.entries) {
        const fileContent = await readMigrationFile(migrationsDir, entry.tag, 'up');
        if (fileContent === null) throw new MigrationFileMissingError(entry.tag);

        const fileSha = hashContent(fileContent);
        const existing = appliedByIdx.get(entry.idx);
        if (existing !== undefined) {
          if (existing.sha256 !== fileSha) {
            throw new MigrationDriftError(entry.tag, existing.sha256, fileSha);
          }
          logger.debug({ tag: entry.tag, idx: entry.idx }, 'migration already applied');
          continue;
        }

        const statements = splitStatements(fileContent, entry.breakpoints);
        logger.info(
          { tag: entry.tag, idx: entry.idx, statements: statements.length },
          'applying migration',
        );

        const startedAt = process.hrtime.bigint();
        await sql.begin(async (tx) => {
          for (const stmt of statements) {
            await tx.unsafe(stmt);
          }
          await tx`
            INSERT INTO ${tx(MIGRATIONS_TABLE)} (idx, tag, sha256, runtime_ms)
            VALUES (${entry.idx}, ${entry.tag}, ${fileSha}, 0)
          `;
        });
        const runtimeMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
        await sql`
          UPDATE ${sql(MIGRATIONS_TABLE)}
          SET runtime_ms = ${runtimeMs}
          WHERE idx = ${entry.idx}
        `;
        applied.push({ tag: entry.tag, runtimeMs });
        logger.info({ tag: entry.tag, idx: entry.idx, runtimeMs }, 'migration applied');
      }
    });

    return applied;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function rollbackLastMigration(
  opts: MigrationOptions,
): Promise<AppliedMigration | null> {
  const { databaseUrl, migrationsDir, logger } = opts;
  const sql = makeConnection(databaseUrl);

  try {
    await ensureMigrationsTable(sql);
    const journal = await readJournal(migrationsDir);
    const journalByIdx = new Map(journal.entries.map((entry) => [entry.idx, entry]));

    return await withAdvisoryLock(sql, async () => {
      const applied = await fetchApplied(sql);
      const last = applied.at(-1);
      if (last === undefined) {
        logger.info('no migrations to roll back');
        return null;
      }

      const entry = journalByIdx.get(last.idx);
      if (entry === undefined) {
        throw new MigrationJournalMismatchError(last.idx, last.tag);
      }

      const downSql = await readMigrationFile(migrationsDir, entry.tag, 'down');
      if (downSql === null) throw new MigrationDownNotDefinedError(entry.tag);

      const statements = splitStatements(downSql, entry.breakpoints);
      logger.info(
        { tag: entry.tag, idx: entry.idx, statements: statements.length },
        'rolling back migration',
      );

      const startedAt = process.hrtime.bigint();
      await sql.begin(async (tx) => {
        for (const stmt of statements) {
          await tx.unsafe(stmt);
        }
        await tx`DELETE FROM ${tx(MIGRATIONS_TABLE)} WHERE idx = ${entry.idx}`;
      });
      const runtimeMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
      logger.info({ tag: entry.tag, idx: entry.idx, runtimeMs }, 'migration rolled back');
      return { tag: entry.tag, runtimeMs };
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function getMigrationStatus(
  opts: StatusOptions,
): Promise<readonly MigrationStatusEntry[]> {
  const { databaseUrl, migrationsDir } = opts;
  const sql = makeConnection(databaseUrl);

  try {
    await ensureMigrationsTable(sql);
    const journal = await readJournal(migrationsDir);
    const applied = await fetchApplied(sql);
    const appliedByIdx = new Map(applied.map((row) => [row.idx, row]));

    const status: MigrationStatusEntry[] = [];
    for (const entry of journal.entries) {
      const fileContent = await readMigrationFile(migrationsDir, entry.tag, 'up');
      if (fileContent === null) throw new MigrationFileMissingError(entry.tag);
      const fileSha = hashContent(fileContent);
      const existing = appliedByIdx.get(entry.idx) ?? null;
      status.push({
        idx: entry.idx,
        tag: entry.tag,
        state: existing === null ? 'pending' : 'applied',
        fileSha256: fileSha,
        appliedSha256: existing?.sha256 ?? null,
        appliedAt: existing?.applied_at ?? null,
        runtimeMs: existing?.runtime_ms ?? null,
        driftDetected: existing !== null && existing.sha256 !== fileSha,
      });
    }
    return status;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
