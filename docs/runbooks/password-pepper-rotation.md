# Password pepper rotation

## When to rotate

- **Suspected compromise of `PASSWORD_PEPPER`.** Treat as P0; rotate
  immediately and force-invalidate all sessions.
- **Annual cadence.** Rotate every 12 months as a routine hardening
  measure, scheduled with the security review.
- **Personnel change with secret access.** Rotate after any operator
  with knowledge of the previous pepper leaves the team.

The pepper itself is never logged, never echoed, and never written to a
file outside the Railway secret manager. Rotation does not require any
user-visible downtime, but does spend ~one argon2id verify per active user
during the rollover window.

## Mechanism

The current `PasswordService` accepts a single active pepper. Rotation
introduces a second pepper for a bounded window:

```
PASSWORD_PEPPER            — new pepper, applied to all *new* hashes
PASSWORD_PEPPER_PREVIOUS   — old pepper, accepted for *verify only*
PASSWORD_PEPPER_ROTATION_DEADLINE — ISO-8601 timestamp after which the
                                    previous pepper is removed
```

`PasswordService.verify` tries the active pepper first, then the previous
pepper if the first fails. On a successful match using the previous
pepper, the service:

1. Returns `true` to the caller so the user is authenticated normally.
2. Sets a `needsRehash` flag on the result tuple.
3. The `AuthService.login` handler re-hashes the password with the active
   pepper and writes the new hash inside the same transaction that issues
   the session — never as a deferred job.

This dual-pepper behavior **requires a schema change** to `users` —
specifically a `password_pepper_v` (smallint, NOT NULL DEFAULT 1) column
that records which pepper version produced the stored hash. Without that
column we cannot distinguish "wrong pepper" from "wrong password" and
would silently double the work for every login. The column is added in
the auth schema migration (Phase 2.2 / 2.7) — until then, the
`PasswordService` defines `needsRehash` against the _parameters_ of the
encoded hash only, not pepper version.

## Procedure

The procedure assumes a healthy production deployment with monitoring
that can graph login latency p95, login error rate, and the count of
hashes that completed the rehash path.

### Step 1 — Generate the new pepper

```sh
openssl rand -base64 48 | tr -d '\n' | head -c 64
```

64 bytes of base64-encoded entropy. Validate the result is exactly 64
characters and contains only base64-safe characters. Do not copy through
a clipboard that may be screen-recorded or logged.

### Step 2 — Stage the rotation in Railway

In the Railway dashboard for the API service:

1. Add `PASSWORD_PEPPER_PREVIOUS` with the **current** pepper value.
2. Replace `PASSWORD_PEPPER` with the **new** pepper value.
3. Add `PASSWORD_PEPPER_ROTATION_DEADLINE` = now + 30 days, ISO-8601.

Apply the variables and let Railway redeploy. Do not deploy the API
process before the previous pepper is in place — any login that arrives
between the new pepper landing and the previous pepper being added will
reject with `INVALID_CREDENTIALS`.

### Step 3 — Watch the rollover

For the first 30 minutes after deploy, monitor:

- `auth.login.latency_ms` p95 — should be stable, since most logins still
  hit the active pepper.
- `auth.login.outcome{result="error"}` — must not spike. A spike means
  the previous pepper variable is wrong; roll back the Railway change.
- `auth.login.rehash_total` — should climb steadily as users log back in.
  After the rotation deadline, this metric falls to zero.

### Step 4 — Finalize

After the rotation deadline:

1. Verify `auth.login.rehash_total` is at zero for at least 7 consecutive
   days.
2. Query the `users` table for rows whose `password_pepper_v` still points
   at the previous version. Those users have not logged in during the
   window — they must reset their password on next login.

   ```sql
   UPDATE users
      SET password_hash = NULL,
          force_password_reset_at = now()
    WHERE password_pepper_v = (SELECT max(version) - 1 FROM password_pepper_history);
   ```

3. Remove `PASSWORD_PEPPER_PREVIOUS` and
   `PASSWORD_PEPPER_ROTATION_DEADLINE` from Railway. Trigger a redeploy.

The rotation is complete when no production process holds the previous
pepper in memory and the variable is no longer present in the secret
store.

## Rollback

If the new pepper is rejected at boot (`EnvValidationError`):

1. Restore `PASSWORD_PEPPER` to the old value (still held in
   `PASSWORD_PEPPER_PREVIOUS`).
2. Remove `PASSWORD_PEPPER_PREVIOUS`.
3. Redeploy.

The window of impact is bounded to the redeploy time (~1 min on Railway).
No user data is corrupted by a failed rotation — only login availability
during the redeploy is affected.

## Why HMAC-SHA256 not bcrypt-prepend

A common alternative is to _prepend_ the pepper to the password before
hashing (`bcrypt(pepper + password)`). HMAC is preferred here because:

- HMAC produces a fixed 32-byte output regardless of input length, which
  bounds the work argon2 must do and removes a DoS-via-long-password
  vector.
- HMAC's two-pass construction prevents length-extension attacks that
  affect naive concatenation under some hash constructions.
- Compared to passing the pepper to argon2 itself as an `associated data`
  parameter, HMAC keeps the pepper out of the argon2id encoded string,
  which is what gets stored. A migration to a new pepper does not require
  inspecting or rewriting argon2 internals.

Concretely:

    stored = argon2id(HMAC-SHA256(pepper, utf8(password)))
