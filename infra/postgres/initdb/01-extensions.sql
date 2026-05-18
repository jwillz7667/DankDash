-- Extensions required by the DankDash schema.
-- Runs once when the Postgres data volume is first initialized.
--
-- PostGIS         -> geofencing, delivery zone polygons, service-area lookups
-- pg_trgm         -> fuzzy text search across product / brand catalogs
-- pgcrypto        -> column-level encryption helpers + gen_random_uuid fallback
-- citext          -> case-insensitive email / handle uniqueness
-- uuid-ossp       -> uuid_generate_v4 for legacy callers (app prefers UUIDv7)
-- btree_gin       -> composite GIN indexes for compliance/audit queries
-- pg_stat_statements -> query-level perf telemetry (read by ops dashboards)

CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "btree_gin";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";
