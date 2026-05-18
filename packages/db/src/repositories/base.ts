import { uuidv7 } from 'uuidv7';
import { type Database } from '../client.js';

export abstract class BaseRepository {
  constructor(protected readonly db: Database) {}
}

/**
 * UUIDv7 is the canonical primary-key shape across the app — time-ordered,
 * cluster-friendly, and the same format the iOS clients generate locally for
 * optimistic IDs. `gen_random_uuid()` remains as the DB fallback for inserts
 * that bypass the repository layer (e.g. migration backfills), but every
 * code path through these repositories generates UUIDv7 explicitly.
 */
export function newId(): string {
  return uuidv7();
}
