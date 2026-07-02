export * as schema from './schema/index.js';
export * from './schema/index.js';
// Re-export the `sql` tagged-template helper so application code that needs
// raw SQL fragments (e.g. set_config for RLS GUCs) does not have to take a
// direct dependency on `drizzle-orm`. The shape mirrors what the repos use
// internally, so a single import surface stays consistent.
export { sql } from 'drizzle-orm';
export {
  createPool,
  createPoolFromEnv,
  type CreatePoolOptions,
  type Database,
  type Pool,
  type Schema,
} from './client.js';
export {
  defaultMigrationsDir,
  getMigrationStatus,
  MigrationDownNotDefinedError,
  MigrationDriftError,
  MigrationFileMissingError,
  MigrationLockBusyError,
  rollbackLastMigration,
  runMigrations,
  type AppliedMigration,
  type MigrationOptions,
  type MigrationStatusEntry,
  type StatusOptions,
} from './migrate.js';
export * from './repositories/index.js';
export {
  resolvePayoutTerminalTransition,
  type PayoutTerminalResolution,
  type PayoutTerminalStatus,
} from './domain/payout-settlement.js';
export { seed, stableUuid, type SeedOptions, type SeedSummary } from './seed.js';
export {
  createEncryptionService,
  createEncryptionServiceFromBase64,
  generateMasterKeyBase64,
  ENCRYPTION_CONTEXT,
  type CreateEncryptionServiceOptions,
  type EncryptionContext,
  type EncryptionService,
} from './encryption.js';
export {
  createDocumentHasher,
  createDocumentHasherFromBase64,
  DOCUMENT_HASH_CONTEXT,
  type CreateDocumentHasherOptions,
  type DocumentHashContext,
  type DocumentHasher,
} from './document-hash.js';
