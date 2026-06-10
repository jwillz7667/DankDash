export type ErrorDetails = Readonly<Record<string, unknown>>;

export interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details: ErrorDetails;
    readonly request_id?: string;
  };
}

/**
 * Base class for every error that crosses a domain boundary.
 *
 * Concrete subclasses set `code` (stable, machine-readable, SCREAMING_SNAKE_CASE)
 * and `statusCode` (HTTP status). The NestJS global exception filter maps any
 * `DomainError` to the standard error envelope from openapi-excerpt.yaml.
 *
 * Non-`DomainError` exceptions are treated as unexpected and surfaced as
 * `INTERNAL_ERROR` — never let raw stack traces leave the process.
 */
export abstract class DomainError extends Error {
  public abstract readonly code: string;
  public abstract readonly statusCode: number;
  public readonly details: ErrorDetails;
  public override readonly cause?: unknown;

  protected constructor(message: string, details: ErrorDetails = {}, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
    if (cause !== undefined) {
      this.cause = cause;
    }
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export class ValidationError extends DomainError {
  public readonly code = 'VALIDATION_FAILED';
  public readonly statusCode = 422;

  constructor(message: string, details: ErrorDetails = {}, cause?: unknown) {
    super(message, details, cause);
  }
}

export class AuthError extends DomainError {
  public readonly code: string;
  public readonly statusCode = 401;

  constructor(
    code:
      | 'UNAUTHENTICATED'
      | 'INVALID_CREDENTIALS'
      | 'TOKEN_EXPIRED'
      | 'TOKEN_INVALID'
      | 'TOKEN_REVOKED'
      | 'MFA_REQUIRED'
      | 'MFA_CODE_INVALID'
      | 'KYC_REQUIRED'
      | 'SESSION_EXPIRED',
    message: string,
    details: ErrorDetails = {},
    cause?: unknown,
  ) {
    super(message, details, cause);
    this.code = code;
  }
}

export class ForbiddenError extends DomainError {
  public readonly code = 'FORBIDDEN';
  public readonly statusCode = 403;

  constructor(message: string, details: ErrorDetails = {}, cause?: unknown) {
    super(message, details, cause);
  }
}

export class NotFoundError extends DomainError {
  public readonly code = 'NOT_FOUND';
  public readonly statusCode = 404;

  constructor(resource: string, identifier: string | number, cause?: unknown) {
    super(`${resource} not found`, { resource, identifier }, cause);
  }
}

export class ConflictError extends DomainError {
  public readonly code: string;
  public readonly statusCode = 409;

  constructor(code: string, message: string, details: ErrorDetails = {}, cause?: unknown) {
    super(message, details, cause);
    this.code = code;
  }
}

/**
 * Raised when a cart, order, or related entity fails a Minnesota
 * cannabis compliance rule. Always include the failing rule(s) in `details`
 * — the API surfaces them so the client can give a precise UX message.
 */
export class ComplianceError extends DomainError {
  public readonly code: string;
  public readonly statusCode = 422;

  constructor(
    code:
      | 'COMPLIANCE_AGE_REQUIRED'
      | 'COMPLIANCE_KYC_REQUIRED'
      | 'COMPLIANCE_HOURS_VIOLATION'
      | 'COMPLIANCE_LIMIT_EXCEEDED'
      | 'COMPLIANCE_GEOFENCE_VIOLATION'
      | 'COMPLIANCE_LICENSE_INVALID'
      | 'COMPLIANCE_PRODUCT_INVALID'
      | 'COMPLIANCE_ID_SCAN_REQUIRED'
      | 'COMPLIANCE_EVALUATION_FAILED',
    message: string,
    details: ErrorDetails = {},
    cause?: unknown,
  ) {
    super(message, details, cause);
    this.code = code;
  }
}

export class InventoryError extends DomainError {
  public readonly code = 'INSUFFICIENT_INVENTORY';
  public readonly statusCode = 409;

  constructor(message: string, details: ErrorDetails = {}, cause?: unknown) {
    super(message, details, cause);
  }
}

export class PaymentError extends DomainError {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(
    code:
      | 'PAYMENT_DECLINED'
      | 'PAYMENT_METHOD_INVALID'
      | 'PAYMENT_PROVIDER_UNAVAILABLE'
      | 'PAYMENT_WEBHOOK_SIGNATURE_INVALID'
      | 'PAYMENT_AMOUNT_MISMATCH'
      | 'REFUND_NOT_ALLOWED',
    message: string,
    details: ErrorDetails = {},
    statusCode = 402,
    cause?: unknown,
  ) {
    super(message, details, cause);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class ExternalServiceError extends DomainError {
  public readonly code = 'EXTERNAL_SERVICE_ERROR';
  public readonly statusCode = 502;

  constructor(service: string, message: string, details: ErrorDetails = {}, cause?: unknown) {
    super(message, { ...details, service }, cause);
  }
}

/**
 * Raised when a repository layer detects an infrastructure invariant
 * violation — e.g. `INSERT ... RETURNING *` returns zero rows, a row that
 * was just written cannot be re-read, or a state transition references a
 * row that has vanished. These are bugs, not user errors; the API surfaces
 * them as INTERNAL_ERROR but the stable `REPOSITORY_INVARIANT_VIOLATION`
 * code lets ops alert on them distinctly from generic 500s.
 */
export class RepositoryError extends DomainError {
  public readonly code = 'REPOSITORY_INVARIANT_VIOLATION';
  public readonly statusCode = 500;

  constructor(message: string, details: ErrorDetails = {}, cause?: unknown) {
    super(message, details, cause);
  }
}

export class RateLimitError extends DomainError {
  public readonly code = 'RATE_LIMIT_EXCEEDED';
  public readonly statusCode = 429;

  constructor(message: string, details: ErrorDetails = {}, cause?: unknown) {
    super(message, details, cause);
  }
}

export type EncryptionErrorCode =
  | 'ENCRYPTION_CONFIG_INVALID'
  | 'ENCRYPTION_FAILED'
  | 'DECRYPTION_FAILED';

/**
 * Raised by the column-encryption helper when a master key is misconfigured,
 * an encrypt operation fails (rare — generally a programmer error), or a
 * decrypt fails because the ciphertext is tampered, the wrong master key was
 * supplied, or the bound context (AAD) does not match the column the value
 * was written to. Surfaces as INTERNAL_ERROR at the API boundary; alerts on
 * the distinct code so operators can distinguish from generic 500s.
 */
export class EncryptionError extends DomainError {
  public readonly code: EncryptionErrorCode;
  public readonly statusCode = 500;

  constructor(
    code: EncryptionErrorCode,
    message: string,
    details: ErrorDetails = {},
    cause?: unknown,
  ) {
    super(message, details, cause);
    this.code = code;
  }
}

export type ConfigErrorCode = 'CONFIG_INVALID' | 'CONFIG_MISSING';

/**
 * Raised at boot when a runtime configuration value cannot be parsed,
 * decoded, or otherwise made usable — distinct from `ValidationError`
 * which is for request input. Surfaces as `INTERNAL_ERROR` to clients
 * (config bugs should never reach end users); the stable `CONFIG_INVALID`
 * / `CONFIG_MISSING` codes let ops alert on them separately from generic
 * 500s. Process should fail fast — `enableShutdownHooks` will not have run
 * if this is thrown from a NestJS factory provider, which is desirable.
 */
export class ConfigError extends DomainError {
  public readonly code: ConfigErrorCode;
  public readonly statusCode = 500;

  constructor(code: ConfigErrorCode, message: string, details: ErrorDetails = {}, cause?: unknown) {
    super(message, details, cause);
    this.code = code;
  }
}

export type KycErrorCode =
  | 'KYC_INQUIRY_FAILED'
  | 'KYC_WEBHOOK_SIGNATURE_INVALID'
  | 'KYC_WEBHOOK_PAYLOAD_INVALID'
  | 'KYC_WEBHOOK_TIMESTAMP_STALE'
  | 'KYC_AGE_UNDER_MINIMUM'
  | 'KYC_DOB_MISSING';

const KYC_STATUS_CODES: Readonly<Record<KycErrorCode, number>> = {
  KYC_INQUIRY_FAILED: 502,
  KYC_WEBHOOK_SIGNATURE_INVALID: 401,
  KYC_WEBHOOK_PAYLOAD_INVALID: 400,
  KYC_WEBHOOK_TIMESTAMP_STALE: 400,
  KYC_AGE_UNDER_MINIMUM: 422,
  KYC_DOB_MISSING: 422,
};

/**
 * Raised by the Persona KYC integration when:
 *   - The upstream API call to create an inquiry fails (502 — provider issue).
 *   - A webhook signature, timestamp, or payload shape cannot be validated
 *     (401 / 400 — caller did not present a trustworthy request).
 *   - A verified inquiry returns a DOB that is missing or under the MN
 *     adult-use minimum of 21 years (422 — user is not eligible).
 *
 * The age and DOB cases surface as 422 because the *request* was well-formed
 * but the *applicant* failed compliance. Signature / timestamp / payload
 * failures are caller-fault and surface as 4xx. Provider failures surface as
 * 502 so ops can alert on Persona availability distinct from client errors.
 */
export class KycError extends DomainError {
  public readonly code: KycErrorCode;
  public readonly statusCode: number;

  constructor(code: KycErrorCode, message: string, details: ErrorDetails = {}, cause?: unknown) {
    super(message, details, cause);
    this.code = code;
    this.statusCode = KYC_STATUS_CODES[code];
  }
}

export type DriverErrorCode =
  | 'DRIVER_NOT_FOUND'
  | 'DRIVER_ALREADY_REGISTERED'
  | 'DRIVER_SHIFT_ALREADY_ACTIVE'
  | 'DRIVER_SHIFT_NOT_ACTIVE'
  | 'DRIVER_STATUS_INVALID'
  | 'DRIVER_OFFER_NOT_FOUND'
  | 'DRIVER_OFFER_EXPIRED'
  | 'DRIVER_OFFER_NOT_YOURS'
  | 'DRIVER_OFFER_ALREADY_RESPONDED'
  | 'DRIVER_BUSY_WITH_ORDER'
  | 'DRIVER_ORDER_NOT_ACTIVE'
  | 'DRIVER_BACKGROUND_INCOMPLETE'
  | 'DRIVER_INSURANCE_EXPIRED'
  | 'DRIVER_NOT_ONLINE';

const DRIVER_STATUS_CODES: Readonly<Record<DriverErrorCode, number>> = {
  DRIVER_NOT_FOUND: 404,
  DRIVER_ALREADY_REGISTERED: 409,
  DRIVER_SHIFT_ALREADY_ACTIVE: 409,
  DRIVER_SHIFT_NOT_ACTIVE: 422,
  DRIVER_STATUS_INVALID: 422,
  DRIVER_OFFER_NOT_FOUND: 404,
  DRIVER_OFFER_EXPIRED: 410,
  DRIVER_OFFER_NOT_YOURS: 403,
  DRIVER_OFFER_ALREADY_RESPONDED: 409,
  DRIVER_BUSY_WITH_ORDER: 409,
  DRIVER_ORDER_NOT_ACTIVE: 409,
  DRIVER_BACKGROUND_INCOMPLETE: 422,
  DRIVER_INSURANCE_EXPIRED: 422,
  DRIVER_NOT_ONLINE: 422,
};

/**
 * Raised by the driver + dispatch surfaces. Each code carries its own HTTP
 * status from `DRIVER_STATUS_CODES` so callers don't have to memorise the
 * mapping; 404 for "no such driver/offer", 403 for cross-driver poking, 410
 * Gone for an offer that timed out, 409 Conflict for state races (already
 * registered, shift already active, offer already responded), 422 for the
 * "request is well-formed but the driver state forbids this" cases.
 */
export class DriverError extends DomainError {
  public readonly code: DriverErrorCode;
  public readonly statusCode: number;

  constructor(code: DriverErrorCode, message: string, details: ErrorDetails = {}, cause?: unknown) {
    super(message, details, cause);
    this.code = code;
    this.statusCode = DRIVER_STATUS_CODES[code];
  }
}

export type PasswordErrorCode =
  | 'PASSWORD_HASH_FAILED'
  | 'PASSWORD_HASH_MALFORMED'
  | 'PASSWORD_INPUT_INVALID';

/**
 * Raised by the password hashing primitive when:
 *   - argon2 fails to produce a hash (system / config problem, not user input)
 *   - a stored hash cannot be parsed (DB corruption or hand-edited row)
 *   - the input violates a defensive ceiling (>1024 bytes pre-HMAC)
 *
 * "Wrong password" is NOT a `PasswordError` — verify() returns false in that
 * case and the caller converts it to `AuthError('INVALID_CREDENTIALS')`.
 * Mapping is intentional: surfacing distinct error codes for crypto failures
 * lets ops alert on them without drowning in normal failed-login noise.
 */
export class PasswordError extends DomainError {
  public readonly code: PasswordErrorCode;
  public readonly statusCode = 500;

  constructor(
    code: PasswordErrorCode,
    message: string,
    details: ErrorDetails = {},
    cause?: unknown,
  ) {
    super(message, details, cause);
    this.code = code;
  }
}

/**
 * Raised when a feature has been intentionally disabled at the deployment
 * (its `ENABLE_*` flag is false) but a request reached a code path that
 * needs it. 503 Service Unavailable is the right status: the surface
 * isn't broken, the deployment is simply not offering it right now.
 *
 * Used by the API's `createDisabledFeatureProxy` to keep the DI graph
 * satisfied at module construction without requiring credentials for a
 * service that won't be called.
 */
export class FeatureDisabledError extends DomainError {
  public readonly code = 'FEATURE_DISABLED';
  public readonly statusCode = 503;

  constructor(feature: string, details: ErrorDetails = {}) {
    super(`feature '${feature}' is disabled`, { ...details, feature });
  }
}

export function toErrorEnvelope(error: DomainError, requestId?: string): ErrorEnvelope {
  return {
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
      ...(requestId !== undefined ? { request_id: requestId } : {}),
    },
  };
}
