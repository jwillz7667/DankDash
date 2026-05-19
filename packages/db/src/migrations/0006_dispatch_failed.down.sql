-- Postgres does not support `ALTER TYPE … DROP VALUE`. Once a value is
-- added to an enum it cannot be removed in-place; a forward-fix migration
-- must map existing rows out of the value first, then a new enum can be
-- created and swapped. This rollback is therefore a no-op — it exists only
-- so the migrator's `*.down.sql` invariant is satisfied symmetrically with
-- the up migration.
SELECT 1;
