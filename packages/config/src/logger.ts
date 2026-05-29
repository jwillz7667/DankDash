import {
  pino,
  type DestinationStream,
  type Logger as PinoLogger,
  type LoggerOptions as PinoOptions,
} from 'pino';

export type Logger = PinoLogger;

export interface LoggerOptions {
  readonly name: string;
  readonly level?: PinoOptions['level'];
  readonly environment?: 'development' | 'test' | 'staging' | 'production';
  readonly extraRedactPaths?: readonly string[];
  /**
   * Optional sink for the structured logs. Defaults to pino's standard
   * destination (stdout). Primarily a test seam so redaction behavior can be
   * asserted in-process; when provided the pino-pretty transport is bypassed
   * (a custom destination and a transport are mutually exclusive in pino).
   */
  readonly destination?: DestinationStream;
}

/**
 * Leaf key names whose values are Restricted (DankDash-Technical-Spec.md
 * §8.1 — DOB, ID document numbers, scan images, license numbers, bank refs,
 * MFA secrets) or are credentials/session tokens. Both snake_case and
 * camelCase forms are listed because the same value is logged snake-cased in
 * raw SQL rows / webhook JSON and camel-cased in Drizzle row objects — a
 * single casing leaves the other form in plaintext.
 *
 * Append-only: never remove a key. The list is crossed with depth prefixes
 * below to produce the actual redaction paths.
 */
const SENSITIVE_LEAF_KEYS: readonly string[] = [
  // Credentials & session/auth tokens
  'password',
  'passwordHash',
  'password_hash',
  'pepper',
  'mfa_secret',
  'mfaSecret',
  'mfa_secret_enc',
  'mfaSecretEnc',
  'refresh_token',
  'refreshToken',
  'refresh_token_hash',
  'refreshTokenHash',
  'access_token',
  'accessToken',
  // Identity — Restricted (§8.1)
  'date_of_birth',
  'dateOfBirth',
  'dob',
  'document_dob_value',
  'documentDobValue',
  'document_number',
  'documentNumber',
  'document_number_hash',
  'documentNumberHash',
  'license_number',
  'licenseNumber',
  'license_number_hash',
  'licenseNumberHash',
  'driver_license_number',
  'driverLicenseNumber',
  'scan_image_key',
  'scanImageKey',
  'delivery_id_scan_ref',
  'deliveryIdScanRef',
  // Payment & bank refs — Restricted (§8.1)
  'aeropay_account_ref',
  'aeropayAccountRef',
  'aeropay_payment_method_ref',
  'aeropayPaymentMethodRef',
  'bank_name',
  'bankName',
];

/**
 * pino's `*` wildcard matches EXACTLY one path segment, so a single `*.dob`
 * does not cover `context.user.dob` or the `err.details.dob` shape the
 * GlobalExceptionFilter logs (it logs the full error object, and a
 * DomainError carries its context bag under `.details`). We enumerate the
 * realistic nesting depths: root, one level deep (`user.dob`), and two
 * levels deep (`err.details.dob` / `context.user.dob`).
 */
const DEPTH_PREFIXES: readonly string[] = ['', '*.', '*.*.'];

// Authorization / cookie live at well-known request paths; enumerate those
// explicitly rather than as generic leaf keys so we don't redact unrelated
// fields that happen to be named `authorization`.
const HEADER_REDACT_PATHS: readonly string[] = [
  'authorization',
  'cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'request.headers.authorization',
  'request.headers.cookie',
  'headers.authorization',
  'headers.cookie',
];

/**
 * Paths whose values must never leave the process in plaintext logs.
 * Sourced from DankDash-Technical-Spec.md §8 and PHASES doc 0.8.
 */
const PII_REDACT_PATHS: readonly string[] = [
  ...DEPTH_PREFIXES.flatMap((prefix) => SENSITIVE_LEAF_KEYS.map((key) => `${prefix}${key}`)),
  ...HEADER_REDACT_PATHS,
];

export function createLogger(options: LoggerOptions): Logger {
  const env = options.environment ?? (process.env['NODE_ENV'] as LoggerOptions['environment']);
  const isProduction = env === 'production' || env === 'staging';
  const redactPaths = [...PII_REDACT_PATHS, ...(options.extraRedactPaths ?? [])];

  const baseOptions: PinoOptions = {
    name: options.name,
    level: options.level ?? process.env['LOG_LEVEL'] ?? 'info',
    redact: {
      paths: redactPaths,
      censor: '[REDACTED]',
      remove: false,
    },
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
      service: options.name,
      env,
    },
  };

  // An explicit destination (test seam) is mutually exclusive with a
  // transport, and takes precedence over the env-based pretty-printing.
  if (options.destination !== undefined) {
    return pino(baseOptions, options.destination);
  }

  if (isProduction) {
    return pino(baseOptions);
  }

  return pino({
    ...baseOptions,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname,service,env',
        singleLine: false,
      },
    },
  });
}
