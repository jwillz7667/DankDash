/**
 * Production env validation checks layered on top of `EnvSchema`.
 *
 * `EnvSchema` enforces shape (required keys, URL syntax, key lengths).
 * These checks enforce *meaning* — environment-correctness, feature-flag
 * coherence, and the JWT key-pair foot-gun — things that look fine to a
 * static validator but break the production system at runtime.
 *
 * Exposed as pure functions so the apps/api CLI can invoke them and
 * unit tests can exercise every rule against synthetic env objects
 * without forking a process. Consumed by
 * `apps/api/src/cli/env-check.ts` and `docs/LAUNCH-CHECKLIST.md` §2.3.
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';

export interface EnvIssue {
  readonly path: string;
  readonly message: string;
}

const PROD_BANNED_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];
const PROD_BANNED_LOG_LEVELS: readonly string[] = ['debug', 'trace'];
const SANDBOX_HOST_MARKERS: readonly string[] = ['sandbox', 'staging', 'test', 'dev'];
// Catches obvious test-credential prefixes used by common SaaS dashboards
// (Aeropay, Stripe-style, Persona, Veriff). Not exhaustive — a vendor could
// ship an opaque token that happens to be a production key but matches this
// pattern; the failure mode is then a false positive on a string the operator
// can override by renaming the value. False negatives (a real test key that
// doesn't match) are caught by the sandbox-URL check.
const TEST_CREDENTIAL_PREFIXES: readonly RegExp[] = [
  /^test[_-]/i,
  /^sandbox[_-]/i,
  /^dev[_-]/i,
  /^sk[_-]test[_-]/i,
  /^pk[_-]test[_-]/i,
  /^tk[_-]test[_-]/i,
  /^ap[_-]test[_-]/i,
  /^public[_-]test[_-]/i,
];

function isBannedHost(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return PROD_BANNED_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

function isSandboxBaseUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    return SANDBOX_HOST_MARKERS.some((marker) => host.includes(marker));
  } catch {
    return false;
  }
}

function looksLikeTestCredential(value: string): boolean {
  return TEST_CREDENTIAL_PREFIXES.some((re) => re.test(value));
}

function readString(env: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = env[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function readBoolean(env: Readonly<Record<string, unknown>>, key: string): boolean {
  const v = env[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === 'true' || v === '1' || v === 'yes';
  return false;
}

/**
 * Returns every issue with the production env that `EnvSchema` cannot
 * catch on its own. Call only when `NODE_ENV` is or claims to be
 * `production`.
 */
export function checkProductionStrict(env: Readonly<Record<string, unknown>>): readonly EnvIssue[] {
  const issues: EnvIssue[] = [];

  const nodeEnv = readString(env, 'NODE_ENV');
  if (nodeEnv !== 'production') {
    issues.push({
      path: 'NODE_ENV',
      message: `must be exactly "production" in a production env-check (got ${JSON.stringify(nodeEnv ?? null)})`,
    });
  }

  const dbUrl = readString(env, 'DATABASE_URL');
  if (dbUrl !== undefined && isBannedHost(dbUrl)) {
    issues.push({
      path: 'DATABASE_URL',
      message: 'must not point at localhost / 127.0.0.1 / ::1 / 0.0.0.0 in production',
    });
  }

  const redisUrl = readString(env, 'REDIS_URL');
  if (redisUrl !== undefined && isBannedHost(redisUrl)) {
    issues.push({
      path: 'REDIS_URL',
      message: 'must not point at localhost / 127.0.0.1 / ::1 / 0.0.0.0 in production',
    });
  }

  const checkoutBaseUrl = readString(env, 'CHECKOUT_BASE_URL');
  if (checkoutBaseUrl !== undefined && isBannedHost(checkoutBaseUrl)) {
    issues.push({
      path: 'CHECKOUT_BASE_URL',
      message:
        'must not point at localhost in production — this URL is embedded in the iOS Apple-§10.4 handoff response',
    });
  }

  const logLevel = readString(env, 'LOG_LEVEL') ?? 'info';
  if (PROD_BANNED_LOG_LEVELS.includes(logLevel)) {
    issues.push({
      path: 'LOG_LEVEL',
      message: `must not be "${logLevel}" in production (allowed: info, warn, error, fatal)`,
    });
  }

  if (readString(env, 'SENTRY_DSN') === undefined) {
    issues.push({
      path: 'SENTRY_DSN',
      message: 'must be set in production (launch-checklist §8 requires Sentry alert routing)',
    });
  }

  if (readString(env, 'OTEL_EXPORTER_OTLP_ENDPOINT') === undefined) {
    issues.push({
      path: 'OTEL_EXPORTER_OTLP_ENDPOINT',
      message: 'must be set in production (launch-checklist §8 requires OTLP traces)',
    });
  }

  issues.push(...checkFeatureFlagCoherence(env));
  issues.push(...checkTwilioSenderCoherence(env));

  return issues;
}

interface FeatureGroup {
  readonly flag: string;
  readonly baseUrlKey: string;
  readonly credentialKeys: readonly string[];
  /**
   * If true, the feature's base URL must point at a non-sandbox host
   * when its flag is enabled.
   */
  readonly forbidSandboxWhenEnabled: boolean;
}

const FEATURE_GROUPS: readonly FeatureGroup[] = [
  {
    flag: 'ENABLE_AEROPAY',
    baseUrlKey: 'AEROPAY_API_BASE_URL',
    credentialKeys: ['AEROPAY_CLIENT_ID', 'AEROPAY_CLIENT_SECRET', 'AEROPAY_WEBHOOK_SECRET'],
    forbidSandboxWhenEnabled: true,
  },
  {
    flag: 'ENABLE_METRC',
    baseUrlKey: 'METRC_API_BASE_URL',
    credentialKeys: ['METRC_API_KEY', 'METRC_USER_KEY'],
    forbidSandboxWhenEnabled: true,
  },
  {
    flag: 'ENABLE_PERSONA',
    baseUrlKey: '',
    credentialKeys: ['PERSONA_API_KEY', 'PERSONA_WEBHOOK_SECRET', 'PERSONA_TEMPLATE_ID'],
    forbidSandboxWhenEnabled: false,
  },
  {
    flag: 'ENABLE_VERIFF',
    baseUrlKey: 'VERIFF_API_BASE_URL',
    credentialKeys: ['VERIFF_API_KEY', 'VERIFF_WEBHOOK_SECRET'],
    forbidSandboxWhenEnabled: true,
  },
];

export function checkFeatureFlagCoherence(
  env: Readonly<Record<string, unknown>>,
): readonly EnvIssue[] {
  const issues: EnvIssue[] = [];

  for (const group of FEATURE_GROUPS) {
    if (!readBoolean(env, group.flag)) continue;

    for (const key of group.credentialKeys) {
      const value = readString(env, key);
      if (value === undefined) {
        issues.push({
          path: key,
          message: `${group.flag}=true requires ${key} to be set`,
        });
        continue;
      }
      if (looksLikeTestCredential(value)) {
        issues.push({
          path: key,
          message: `${key} looks like a test credential (prefix matches test_/sandbox_/dev_); ${group.flag}=true must use a production credential`,
        });
      }
    }

    if (group.baseUrlKey.length > 0 && group.forbidSandboxWhenEnabled) {
      const url = readString(env, group.baseUrlKey);
      if (url !== undefined && isSandboxBaseUrl(url)) {
        issues.push({
          path: group.baseUrlKey,
          message: `${group.flag}=true but ${group.baseUrlKey} (${url}) points at a sandbox/staging/test host`,
        });
      }
    }
  }

  // Aeropay has an extra `AEROPAY_LIVE` switch that gates driver payouts
  // specifically — when true, the same Aeropay credentials move money to a
  // real bank, so re-check non-test even if ENABLE_AEROPAY is false (defensive:
  // flipping AEROPAY_LIVE without ENABLE_AEROPAY is incoherent at the module
  // level too, but we surface a clear message here so the operator sees it).
  if (readBoolean(env, 'AEROPAY_LIVE')) {
    for (const key of ['AEROPAY_CLIENT_ID', 'AEROPAY_CLIENT_SECRET']) {
      const value = readString(env, key);
      if (value !== undefined && looksLikeTestCredential(value)) {
        issues.push({
          path: key,
          message: `AEROPAY_LIVE=true requires a non-test ${key} (it moves real money to driver bank accounts)`,
        });
      }
    }
    const aeropayUrl = readString(env, 'AEROPAY_API_BASE_URL');
    if (aeropayUrl !== undefined && isSandboxBaseUrl(aeropayUrl)) {
      issues.push({
        path: 'AEROPAY_API_BASE_URL',
        message: `AEROPAY_LIVE=true but AEROPAY_API_BASE_URL (${aeropayUrl}) points at a sandbox/staging/test host`,
      });
    }
  }

  return issues;
}

/**
 * Twilio outbound transactional SMS requires exactly one of
 * `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_FROM_NUMBER` — both unset
 * means SMS delivery silently no-ops, both set means the schema accepts
 * it but the runtime has ambiguous routing.
 *
 * The schema marks both optional (so dev/preview can stay SMS-less), so
 * this is a production-tier check.
 */
export function checkTwilioSenderCoherence(
  env: Readonly<Record<string, unknown>>,
): readonly EnvIssue[] {
  const sid = readString(env, 'TWILIO_MESSAGING_SERVICE_SID');
  const from = readString(env, 'TWILIO_FROM_NUMBER');
  if (sid === undefined && from === undefined) {
    return [
      {
        path: 'TWILIO_MESSAGING_SERVICE_SID|TWILIO_FROM_NUMBER',
        message:
          'exactly one of TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER must be set for outbound transactional SMS',
      },
    ];
  }
  if (sid !== undefined && from !== undefined) {
    return [
      {
        path: 'TWILIO_MESSAGING_SERVICE_SID|TWILIO_FROM_NUMBER',
        message:
          'set exactly one of TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER — both set is ambiguous',
      },
    ];
  }
  return [];
}

/**
 * Confirms that JWT_PRIVATE_KEY_BASE64 decodes to a PEM whose public
 * half matches JWT_PUBLIC_KEY_BASE64. A mismatched pair is the single
 * most common rotation foot-gun — `EnvSchema` accepts it because both
 * keys are just non-empty base64 strings.
 *
 * Runs in all environments, not just production: a broken JWT pair
 * makes every authenticated request fail.
 */
export function checkJwtKeyPair(env: Readonly<Record<string, unknown>>): readonly EnvIssue[] {
  const privBase64 = readString(env, 'JWT_PRIVATE_KEY_BASE64');
  const pubBase64 = readString(env, 'JWT_PUBLIC_KEY_BASE64');
  if (privBase64 === undefined || pubBase64 === undefined) return [];

  let privPem: string;
  let pubPem: string;
  try {
    privPem = Buffer.from(privBase64, 'base64').toString('utf8');
    pubPem = Buffer.from(pubBase64, 'base64').toString('utf8');
  } catch (err: unknown) {
    return [
      {
        path: 'JWT_*_KEY_BASE64',
        message: `failed to base64-decode JWT key material: ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
  }

  let derived: Buffer;
  let declared: Buffer;
  try {
    const priv = createPrivateKey({ key: privPem, format: 'pem' });
    derived = Buffer.from(createPublicKey(priv).export({ type: 'spki', format: 'pem' }) as string);
    declared = Buffer.from(
      createPublicKey({ key: pubPem, format: 'pem' }).export({
        type: 'spki',
        format: 'pem',
      }) as string,
    );
  } catch (err: unknown) {
    return [
      {
        path: 'JWT_*_KEY_BASE64',
        message: `JWT key material is not valid PEM: ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
  }

  if (Buffer.compare(derived, declared) !== 0) {
    return [
      {
        path: 'JWT_*_KEY_BASE64',
        message:
          'JWT_PUBLIC_KEY_BASE64 does not match the public key derived from JWT_PRIVATE_KEY_BASE64 — token signatures will not validate',
      },
    ];
  }
  return [];
}

/**
 * Composes the full check sequence. Always runs the JWT pair check;
 * runs the strict overlay when `NODE_ENV=production`.
 */
export function runAllChecks(env: Readonly<Record<string, unknown>>): readonly EnvIssue[] {
  const issues: EnvIssue[] = [...checkJwtKeyPair(env)];
  if (readString(env, 'NODE_ENV') === 'production') {
    issues.push(...checkProductionStrict(env));
  }
  return issues;
}

export function formatIssueReport(issues: readonly EnvIssue[]): string {
  const lines = issues.map((issue) => `  - ${issue.path}: ${issue.message}`);
  return ['env-check: FAILED', ...lines, ''].join('\n');
}
