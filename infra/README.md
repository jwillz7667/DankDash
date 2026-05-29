# DankDash — Infrastructure

Container images, Railway service configs, and local-compose for the
backend tier.

## Layout

```
infra/
  Dockerfile.api          # multi-stage build for apps/api
  Dockerfile.workers      # multi-stage build for apps/workers
  Dockerfile.realtime     # multi-stage build for apps/realtime (Socket.io)
  railway.api.toml        # per-service Railway config
  railway.workers.toml
  railway.realtime.toml
  postgres/               # docker-compose Postgres+PostGIS for local dev
  localstack/             # docker-compose LocalStack for local R2-equivalent
```

## Railway model

The project (`dankdash`) holds one environment (`production`) with five
services:

| Service                  | Source              | Deploys                                                |
| ------------------------ | ------------------- | ------------------------------------------------------ |
| `@dankdash/api`          | `apps/api`          | Railway                                                |
| `@dankdash/workers`      | `apps/workers`      | Railway                                                |
| `@dankdash/realtime`     | `apps/realtime`     | Railway                                                |
| `@dankdash/portal`       | `apps/portal`       | **Vercel** (this Railway service stub will be removed) |
| `@dankdash/checkout-web` | `apps/checkout-web` | **Vercel** (this Railway service stub will be removed) |

Plus two managed databases: Postgres (Railway PG 16; PostGIS extension
enabled post-create) and `Redis`.

> **Live state (production env):** the active Postgres service is named
> **`postgis`** — every app service's `DATABASE_URL` resolves to
> `postgis.railway.internal:5432`. The four orphan Postgres services left
> over from provisioning iterations (`Postgres`, `Postgres-1geX`,
> `Postgres-mAID`, `Postgres-SVLJ`) were **deleted** on 2026-05-29 after
> confirming each held zero user tables (empty Postgres 18 templates,
> no PostGIS, no schema). Their detached volumes plus one pre-existing
> detached volume linger because Railway's `volumeDelete` API is a no-op
> on service-orphaned volumes — remove them from the dashboard
> (Volumes → Delete) or via `railway volume delete -v <name>` in an
> interactive terminal. The project is on the **Hobby** plan, which caps
> services at a single replica — `numReplicas > 1` in these tomls only
> takes effect on Pro.
>
> **Deploys** are driven solely by Railway's GitHub trigger (auto-deploy
> on push to `main`). Each service's trigger has `checkSuites` ("Wait for
> CI") enabled, so Railway blocks a deploy until the `ci` workflow passes
> for that commit. There are no GitHub Actions deploy workflows — `ci.yml`
> validates, Railway deploys.

### Per-service config path

Railway services upload the full repo root for the build context (so the
pnpm workspace can be installed), but each one points at its own
`railway.toml` via the `configPath` field on the service. This is set
once via the GraphQL API (the dashboard exposes the same field as
"Config-as-code path"):

```bash
TOKEN=$(python3 -c "import json; print(json.load(open('$HOME/.railway/config.json'))['user']['token'])")
SERVICE_ID=<service-uuid>
CONFIG_PATH=infra/railway.api.toml

curl -s -X POST https://backboard.railway.app/graphql/v2 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"mutation { serviceInstanceUpdate(serviceId: \\\"$SERVICE_ID\\\", input: { configPath: \\\"$CONFIG_PATH\\\" }) }\"}"
```

### Reference variables

Each app service reads `DATABASE_URL` and `REDIS_URL` via Railway's
reference-variable syntax so the secrets never appear in code or in
git:

```
DATABASE_URL = ${{postgis.DATABASE_URL}}
REDIS_URL    = ${{Redis.REDIS_URL}}
```

Note the DB reference targets the **`postgis`** service (the active
Postgres instance), not a service literally named `Postgres`. These are
wired via `railway variables --service <svc> --set "KEY=value"` or via
the dashboard. They must be **literal strings** with the `${{...}}`
syntax — Railway expands them at deploy time. Prefer the reference form
over pasting an expanded connection string so a credential rotation on
`postgis` propagates automatically.

Realtime additionally requires `JWT_PUBLIC_KEY_BASE64` (verify-only — it
never signs) and, for browser clients (the vendor portal), an explicit
`SOCKET_CORS_ORIGINS` allow-list. With `SOCKET_CORS_ORIGINS` empty the
Socket.io server reflects any request origin, so set it to the portal's
production origin(s) before launch; the JWT handshake is the primary
gate but the origin allow-list is defense in depth.

### Application secrets

Secrets owned by the user (not derivable from Railway's own services):

| Variable                 | Owner / source                    | Phase wired        |
| ------------------------ | --------------------------------- | ------------------ |
| `JWT_PRIVATE_KEY_PEM`    | local RSA keypair (RS256)         | 2 (auth)           |
| `JWT_PUBLIC_KEY_PEM`     | matching public key               | 2                  |
| `AEROPAY_CLIENT_ID`      | Aeropay sandbox dashboard         | 6 (payments)       |
| `AEROPAY_CLIENT_SECRET`  | Aeropay sandbox dashboard         | 6                  |
| `AEROPAY_API_BASE_URL`   | `https://api.sandbox.aeropay.com` | 6                  |
| `AEROPAY_WEBHOOK_SECRET` | Aeropay dashboard                 | 6                  |
| `STRIPE_SECRET_KEY`      | Stripe (vendor billing)           | 14                 |
| `VERIFF_API_KEY`         | Veriff dashboard                  | 11                 |
| `VERIFF_API_SECRET`      | Veriff dashboard                  | 11                 |
| `METRC_API_KEY`          | Minnesota Metrc account           | 13                 |
| `METRC_USER_API_KEY`     | per-account Metrc key             | 13                 |
| `R2_ACCESS_KEY_ID`       | Cloudflare R2                     | 4 (uploads)        |
| `R2_SECRET_ACCESS_KEY`   | Cloudflare R2                     | 4                  |
| `R2_BUCKET_NAME`         | Cloudflare R2                     | 4                  |
| `R2_ACCOUNT_ID`          | Cloudflare R2                     | 4                  |
| `RESEND_API_KEY` _or_    | Resend dashboard                  | 10 (notifications) |
| `POSTMARK_SERVER_TOKEN`  | Postmark dashboard                | 10                 |

None of these are required for the build itself — `ALLOW_PARTIAL_ENV=0`
on each service will surface missing required vars at boot, not at
build. Set them in the dashboard or via:

```bash
railway variables --service @dankdash/api --set "JWT_PRIVATE_KEY_PEM=$(cat /path/to/key.pem)"
```

## Local development

`docker compose up` at the repo root brings up:

- Postgres 16 + PostGIS extension preloaded
- Redis 7
- LocalStack for S3-equivalent uploads

This is the loop that the Phase 0 docker-compose targets; no Railway
account needed for `pnpm dev`.

## PostGIS + extensions

Railway's Postgres template ships plain Postgres 16. After the service
is provisioned, connect with `railway connect Postgres` (or `psql
$DATABASE_PUBLIC_URL`) and run:

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
```

Migration `0000_init.sql` is idempotent about these (`CREATE EXTENSION
IF NOT EXISTS`), so re-running migrations against a fresh Postgres also
works.

## Useful commands

```bash
# Pull all variables for an environment into a local .env (DO NOT COMMIT)
railway variables --service @dankdash/api --kv > .env.production.local

# Run a one-shot command against the production env's variables
railway run --service @dankdash/api -- pnpm --filter @dankdash/db migrate

# Tail logs for a deploy
railway logs --service @dankdash/api --deployment=<id>
```
