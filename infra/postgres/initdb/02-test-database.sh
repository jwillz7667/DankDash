#!/usr/bin/env bash
# Creates the dedicated test database used by integration tests.
# The default `dankdash` database is reserved for `pnpm dev` so that
# `pnpm test:integration` can truncate freely without disturbing dev state.

set -euo pipefail

psql --variable=ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER}" \
  --dbname "${POSTGRES_DB}" <<-EOSQL
  SELECT 'CREATE DATABASE dankdash_test OWNER ${POSTGRES_USER}'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'dankdash_test')\gexec
EOSQL

psql --variable=ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER}" \
  --dbname dankdash_test <<-'EOSQL'
  CREATE EXTENSION IF NOT EXISTS "postgis";
  CREATE EXTENSION IF NOT EXISTS "pg_trgm";
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";
  CREATE EXTENSION IF NOT EXISTS "citext";
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  CREATE EXTENSION IF NOT EXISTS "btree_gin";
EOSQL
