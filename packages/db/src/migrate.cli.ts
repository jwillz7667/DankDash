/**
 * Migration CLI dispatcher. Invoked by package.json scripts:
 *   pnpm --filter @dankdash/db migrate           -> up
 *   pnpm --filter @dankdash/db migrate:rollback  -> down
 *   pnpm --filter @dankdash/db migrate:status    -> status
 *
 * Reads DATABASE_URL from the environment. In CI / production the deploy
 * platform sets this; locally it ships in `.env` and is loaded by the dev
 * task runner upstream of this script (tsx + dotenv-cli in the package script).
 */
import { pino, type LoggerOptions } from 'pino';
import {
  defaultMigrationsDir,
  getMigrationStatus,
  MigrationDownNotDefinedError,
  MigrationDriftError,
  MigrationFileMissingError,
  MigrationJournalMismatchError,
  MigrationLockBusyError,
  rollbackLastMigration,
  runMigrations,
} from './migrate.js';

const COMMANDS = ['up', 'down', 'status'] as const;
type Command = (typeof COMMANDS)[number];

class MissingDatabaseUrlError extends Error {
  public override readonly name = 'MissingDatabaseUrlError';
  constructor() {
    super(
      'DATABASE_URL is required. Run `cp .env.example .env` and start the dev stack with `docker compose up -d`.',
    );
  }
}

function isCommand(value: string | undefined): value is Command {
  return typeof value === 'string' && (COMMANDS as readonly string[]).includes(value);
}

function readDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url.length === 0) {
    throw new MissingDatabaseUrlError();
  }
  return url;
}

function formatStatusLine(entry: {
  readonly idx: number;
  readonly tag: string;
  readonly state: 'applied' | 'pending';
  readonly appliedAt: Date | null;
  readonly runtimeMs: number | null;
  readonly driftDetected: boolean;
}): string {
  const idx = String(entry.idx).padStart(4, '0');
  const tag = entry.tag.padEnd(40);
  const state = entry.state.padEnd(8);
  const appliedAt = entry.appliedAt?.toISOString() ?? '—';
  const runtime = entry.runtimeMs === null ? '—' : `${entry.runtimeMs}ms`;
  const drift = entry.driftDetected ? '  !! DRIFT' : '';
  return `${idx}  ${tag}  ${state}  applied=${appliedAt}  runtime=${runtime}${drift}`;
}

const KNOWN_ERROR_TYPES = [
  MigrationLockBusyError,
  MigrationDriftError,
  MigrationDownNotDefinedError,
  MigrationFileMissingError,
  MigrationJournalMismatchError,
  MissingDatabaseUrlError,
] as const;

function isKnownMigrationError(
  error: unknown,
): error is InstanceType<(typeof KNOWN_ERROR_TYPES)[number]> {
  return KNOWN_ERROR_TYPES.some((Ctor) => error instanceof Ctor);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!isCommand(command)) {
    process.stderr.write(`Usage: migrate <${COMMANDS.join('|')}>\n`);
    process.exit(2);
  }

  const baseLoggerOptions: LoggerOptions = {
    name: 'db.migrate',
    level: process.env['LOG_LEVEL'] ?? 'info',
  };
  const loggerOptions: LoggerOptions =
    process.env['NODE_ENV'] === 'production'
      ? baseLoggerOptions
      : {
          ...baseLoggerOptions,
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        };
  const logger = pino(loggerOptions);

  const migrationsDirOverride = process.env['DANKDASH_MIGRATIONS_DIR'];
  const migrationsDir =
    migrationsDirOverride !== undefined && migrationsDirOverride.length > 0
      ? migrationsDirOverride
      : defaultMigrationsDir(import.meta.url);
  const databaseUrl = readDatabaseUrl();

  try {
    if (command === 'up') {
      const applied = await runMigrations({ databaseUrl, migrationsDir, logger });
      if (applied.length === 0) {
        logger.info('database is up to date; no migrations applied');
      } else {
        logger.info(
          { count: applied.length, migrations: applied },
          `applied ${applied.length} migration(s)`,
        );
      }
      return;
    }

    if (command === 'down') {
      const reverted = await rollbackLastMigration({ databaseUrl, migrationsDir, logger });
      if (reverted === null) {
        logger.warn('no migrations to roll back');
      } else {
        logger.info({ reverted }, `rolled back ${reverted.tag}`);
      }
      return;
    }

    const entries = await getMigrationStatus({ databaseUrl, migrationsDir });
    const lines = entries.map((entry) => formatStatusLine(entry));
    process.stdout.write(`${lines.join('\n')}\n`);
    const driftCount = entries.filter((entry) => entry.driftDetected).length;
    if (driftCount > 0) {
      process.stderr.write(
        `\n${driftCount} migration(s) show content drift — investigate before deploying.\n`,
      );
      process.exit(1);
    }
  } catch (error) {
    if (isKnownMigrationError(error)) {
      logger.error({ err: error.message, type: error.name }, 'migration aborted');
      process.exit(1);
    }
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    logger.error({ err: message, stack }, 'migration failed');
    process.exit(1);
  }
}

void main();
