import { pino, type Logger as PinoLogger, type LoggerOptions as PinoOptions } from 'pino';

export type Logger = PinoLogger;

export interface LoggerOptions {
  readonly name: string;
  readonly level?: PinoOptions['level'];
  readonly environment?: 'development' | 'test' | 'staging' | 'production';
  readonly extraRedactPaths?: readonly string[];
  /**
   * Optional pino mixin. The api/realtime/workers pass
   * `requestContextMixin` from `@dankdash/observability` so every log
   * record carries the ALS-bound request_id/trace_id/span_id without
   * threading the request through every call site.
   */
  readonly mixin?: PinoOptions['mixin'];
}

/**
 * Paths whose values must never leave the process in plaintext logs.
 * Sourced from DankDash-Technical-Spec.md §8 and PHASES doc 0.8.
 * Additions here are append-only — never remove a path.
 */
const PII_REDACT_PATHS: readonly string[] = [
  'password',
  'password_hash',
  'passwordHash',
  'mfa_secret',
  'mfa_secret_enc',
  'mfaSecret',
  'pepper',
  'date_of_birth',
  'dateOfBirth',
  'dob',
  'scan_image_key',
  'scanImageKey',
  'document_number_hash',
  'documentNumber',
  'driverLicenseNumber',
  'license_number',
  'aeropay_account_ref',
  'aeropayPaymentMethodRef',
  'refresh_token',
  'refreshToken',
  'refresh_token_hash',
  'access_token',
  'accessToken',
  'authorization',
  'cookie',
  '*.password',
  '*.password_hash',
  '*.mfa_secret',
  '*.mfa_secret_enc',
  '*.date_of_birth',
  '*.dateOfBirth',
  '*.dob',
  '*.scan_image_key',
  '*.scanImageKey',
  '*.refresh_token',
  '*.refresh_token_hash',
  '*.access_token',
  'req.headers.authorization',
  'req.headers.cookie',
  'request.headers.authorization',
  'request.headers.cookie',
  'headers.authorization',
  'headers.cookie',
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
    ...(options.mixin !== undefined ? { mixin: options.mixin } : {}),
  };

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
