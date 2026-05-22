# JWT access-token key rotation

## When to rotate

- **Suspected compromise of `JWT_PRIVATE_KEY_BASE64`.** Treat as P0;
  rotate immediately and revoke every issued session.
- **Annual cadence.** Rotate every 12 months as a routine hardening
  measure, scheduled alongside the password-pepper rotation in the
  security review.
- **Personnel change with secret access.** Rotate after any operator
  with knowledge of the previous private key leaves the team.
- **Algorithm or key-size upgrade.** A move from RS256 to PS256 or
  from RSA-2048 to RSA-4096 is a rotation event — same procedure,
  different keygen step.

The private key is never logged, never echoed, never written to a
file outside the Railway secret manager. Rotation has no user-visible
downtime: access tokens carry a `kid` header and verifiers accept
both the previous and the active key during a bounded overlap window.

## Mechanism

`JwtService` signs every token with the current `keyId` claim
(`kid: 'v1'` today). Verification currently pins a single public key;
rotation requires the verifier to resolve a public key by the `kid`
in the incoming token header. Two env vars hold the active key pair,
two more hold the previous pair, and a deadline pins when the
previous pair is dropped:

```
JWT_PRIVATE_KEY_BASE64           — new private key, signs all new tokens
JWT_PUBLIC_KEY_BASE64            — new public key, verifies new tokens
JWT_KEY_ID                       — new kid, e.g. 'v2'

JWT_PUBLIC_KEY_PREVIOUS_BASE64   — old public key, verify-only
JWT_KEY_ID_PREVIOUS              — old kid, e.g. 'v1'

JWT_KEY_ROTATION_DEADLINE        — ISO-8601 UTC timestamp after which
                                   the previous public key is removed.
                                   Must be ≥ JWT_ACCESS_TTL_SECONDS in
                                   the future or in-flight tokens are
                                   orphaned.
```

`JwtService.verifyAccessToken` parses the JWT header (`complete: true`
in the rotation-aware build), reads `kid`, looks up the matching
public key from the in-process map, and runs `jwt.verify` against it.
A token with an unknown `kid` rejects with `AuthError(TOKEN_INVALID)`
— same shape as any other tampered token, no information leaked
about which keys are loaded.

`signAccessToken` never reads the previous key — new tokens always
carry the active `kid`. This means a token minted before rotation
keeps verifying with the previous public key until it naturally
expires (≤ `JWT_ACCESS_TTL_SECONDS`, currently 15 minutes), and a
token minted after rotation verifies with the active public key
everywhere.

## Procedure

The procedure assumes a healthy production deployment with
observability that can graph access-token verify latency, the count
of verify failures by reason code, and the distribution of `kid`
values landing at the verifier (a Grafana panel on the JWT
verification histogram, broken out by `kid` label).

### Step 1 — Generate the new RSA-2048 key pair

```sh
# Private key (PKCS#8 PEM) — never leaves the operator workstation
# except as the base64 value loaded into Railway.
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -out jwt-v2-private.pem

# Public key (SPKI PEM)
openssl pkey -in jwt-v2-private.pem -pubout -out jwt-v2-public.pem

# Base64-encode both for Railway env vars (no line wrapping)
base64 -w 0 < jwt-v2-private.pem > jwt-v2-private.b64
base64 -w 0 < jwt-v2-public.pem  > jwt-v2-public.b64
```

Validate the result:

```sh
openssl rsa -in jwt-v2-private.pem -check -noout   # → "RSA key ok"
openssl rsa -in jwt-v2-private.pem -pubout -outform PEM \
  | diff - jwt-v2-public.pem                       # → no output
```

Shred the `.pem` files after the base64 values are stored in Railway:

```sh
shred -u jwt-v2-private.pem jwt-v2-private.b64
rm jwt-v2-public.pem jwt-v2-public.b64
```

Do not copy the private key through a clipboard that may be
screen-recorded, paste-bin-logged, or backed up to iCloud. Paste
directly into the Railway env-var input.

### Step 2 — Stage the overlap window in Railway

In the Railway dashboard, on every service that verifies JWTs
(`api`, `realtime`, `workers` if it accepts authenticated webhooks):

1. Add `JWT_PUBLIC_KEY_PREVIOUS_BASE64` with the **current** public
   key value (copy from the existing `JWT_PUBLIC_KEY_BASE64`).
2. Add `JWT_KEY_ID_PREVIOUS` with the **current** `kid` (default
   `v1` if never rotated before).
3. Replace `JWT_PUBLIC_KEY_BASE64` with the **new** v2 public key.
4. Add `JWT_KEY_ROTATION_DEADLINE` = now + 24h (ISO-8601 UTC). The
   24h window is `15 min` (max access-token TTL) × `96` for a wide
   margin against clock skew between services.

On the `api` service only:

5. Replace `JWT_PRIVATE_KEY_BASE64` with the **new** v2 private key.
6. Set `JWT_KEY_ID` to `v2`.

Apply the variables. Railway redeploys per service. **Deploy
`realtime` and `workers` (verify-only services) before `api` (signer)**
so no token is minted with `v2` until every verifier has the v2
public key loaded. Out-of-order deploys produce a brief window where
new tokens (kid=v2) hit a verifier that doesn't know v2 → 401 for
every authenticated request to that service.

### Step 3 — Watch the rollover

For the first 30 minutes after the api redeploy, monitor:

- `jwt_verify_total{kid="v1",result="ok"}` — should fall to zero
  over the next `JWT_ACCESS_TTL_SECONDS` (~15 min). If it doesn't
  fall to zero by the deadline, something is still minting v1 — most
  likely an api instance that didn't pick up the new env vars.
- `jwt_verify_total{kid="v2",result="ok"}` — should climb steadily.
- `jwt_verify_total{result="error"}` by `reason` — must not spike.
  `TOKEN_INVALID` spike means a verifier didn't get the v2 public
  key; roll back the Railway change on that service.
- `auth.login.outcome{result="error"}` — must not spike. A spike at
  this layer means the signer is broken (wrong private key format,
  base64 padding lost in copy/paste). Roll back immediately.

If the metrics look bad and you are within the 30-minute window,
restore the previous private key on the api and remove
`JWT_PUBLIC_KEY_PREVIOUS_BASE64` to undo the rotation. Window of
impact: the redeploy time (~1 min on Railway). No user is signed
out — their existing v1 token continues to verify because the
verifier still has the v1 public key.

### Step 4 — Finalize after the deadline

After `JWT_KEY_ROTATION_DEADLINE` has passed and
`jwt_verify_total{kid="v1"}` has been at zero for at least one
hour:

1. Remove `JWT_PUBLIC_KEY_PREVIOUS_BASE64` from every service.
2. Remove `JWT_KEY_ID_PREVIOUS` from every service.
3. Remove `JWT_KEY_ROTATION_DEADLINE` from every service.
4. Trigger a redeploy on each service.

The rotation is complete when no production process holds the v1
public key in memory and the variable is no longer present in the
secret store.

The previous private key has not been in any running process since
Step 2. It exists only in whatever audit log Railway keeps of past
env var values — if that log is itself a concern, escalate to
Infrastructure to scrub it per the Railway data-retention policy.

## Coordinating refresh-token sessions

Refresh tokens are stored as hashed bytea on the `auth_sessions`
table and are not affected by access-key rotation. The next time a
client exchanges a refresh token for a new access token, the issued
access token carries `kid=v2` automatically — no migration needed.

If the rotation is response to a **compromise** of the previous
private key (rather than a routine annual rotation), perform an
additional step before Step 2 above:

```sql
UPDATE auth_sessions
   SET revoked_at = now(),
       revoked_reason = 'JWT_KEY_COMPROMISE_<YYYYMMDD>'
 WHERE revoked_at IS NULL;
```

Every active session is invalidated. Users are forced to re-login
on next refresh, and any access token minted with the compromised
key becomes useless within `JWT_ACCESS_TTL_SECONDS` of its issuance
even if the attacker still holds the private key — because the
session it was minted against is now revoked, and access-token
verification cross-references session validity at the guard layer.

## Rollback

The window of impact for a failed rotation is bounded by the
Railway redeploy time (~1 min per service).

**If the new private key is rejected at boot** (`EnvValidationError`,
"invalid PEM", or "key too short"):

1. Restore `JWT_PRIVATE_KEY_BASE64` to the value held in
   `JWT_PUBLIC_KEY_PREVIOUS_BASE64` (no — the previous _private_
   key is not stored in the rotation env vars; it must come from
   the operator's pre-rotation backup, see Step 1's note about
   shredding).
2. If no backup is available, the rotation cannot be rolled back
   forward — instead, treat this as a forward-only situation: the
   api stays on whatever last-good config it had, and the operator
   regenerates Step 1 with a fresh keypair.

**If verify-side errors spike** (clients can't authenticate with
v2-minted tokens):

1. Revert `JWT_PUBLIC_KEY_BASE64` on the affected service back to
   the v1 value (from `JWT_PUBLIC_KEY_PREVIOUS_BASE64`).
2. Revert `JWT_KEY_ID` to `v1` on the api signer.
3. Redeploy.
4. Diagnose the v2 key shape offline before retrying.

**If a single instance is lagging** (most verifies are ok, a small
fraction fail with `TOKEN_INVALID`):

The instance has stale env vars. Force a redeploy of that service
via the Railway dashboard or `railway redeploy --service <name>`.

## Why RS256 + kid

A common alternative is symmetric HS256 with a shared secret across
api/realtime/workers. RS256 + kid is preferred here because:

- **Compromise containment.** The realtime and workers services
  verify tokens but never mint them. With HS256 they would have to
  hold the signing secret; with RS256 they hold only the public
  key. A compromise of one of those services does not give the
  attacker a signing oracle.
- **External partners.** The same access tokens will eventually
  travel to partner integrations (e.g. delivery-vendor APIs). An
  asymmetric scheme lets partners verify without ever holding the
  ability to mint a token in our name.
- **Rotation safety.** The `kid` claim lets a verifier accept tokens
  from multiple key generations simultaneously without ambiguity —
  the procedure above takes ~30 min and has zero downtime. A pure
  HS256 rotation would have to either invalidate every active
  session at the rotation moment, or accept both secrets and try
  each in turn (which has the same security posture as multi-kid
  but worse observability).

## Postmortem template

After every rotation, file an entry under `docs/security/key-rotation-log.md`
with:

- Date / operator / reason (annual | compromise | personnel-change | upgrade)
- Generated `kid` value
- Time elapsed Step 1 → Step 4
- Anomalies during the rollover window (any 401 spikes? any service
  that needed a manual redeploy?)
- Backup status: was the previous private key recoverable for the
  duration of the overlap window? (For compromise rotations the
  answer must be "no — destroyed in Step 1".)

If the rotation was triggered by suspected compromise, file a
separate incident report in `docs/security/incidents/` referencing
this entry. Include scope of access (which sessions were active
during the window the previous key may have been held by the
attacker), notification posture (was a customer-facing notice
required under MN data-breach law?), and the forensic trail.
