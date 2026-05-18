import { describe, expect, it } from 'vitest';
import {
  AuthError,
  ComplianceError,
  ConfigError,
  ConflictError,
  DomainError,
  ExternalServiceError,
  ForbiddenError,
  InventoryError,
  NotFoundError,
  PaymentError,
  RateLimitError,
  RepositoryError,
  ValidationError,
  toErrorEnvelope,
} from '../src/errors.js';

describe('DomainError hierarchy', () => {
  it('every concrete error is an instanceof DomainError and Error', () => {
    const samples: DomainError[] = [
      new ValidationError('bad input'),
      new AuthError('INVALID_CREDENTIALS', 'wrong password'),
      new ForbiddenError('not yours'),
      new NotFoundError('Order', 'ord_123'),
      new ConflictError('CART_LOCKED', 'cart in use'),
      new ComplianceError('COMPLIANCE_LIMIT_EXCEEDED', 'over MN limit'),
      new InventoryError('out of stock'),
      new PaymentError('PAYMENT_DECLINED', 'declined'),
      new ExternalServiceError('aeropay', 'timeout'),
      new RateLimitError('too many requests'),
      new RepositoryError('orders insert returned no row'),
      new ConfigError('CONFIG_INVALID', 'JWT_PRIVATE_KEY_BASE64 is not base64'),
    ];

    for (const error of samples) {
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe(error.constructor.name);
      expect(typeof error.code).toBe('string');
      expect(error.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(error.statusCode).toBeGreaterThanOrEqual(400);
      expect(error.statusCode).toBeLessThan(600);
      expect(error.details).toBeDefined();
    }
  });

  it('ValidationError uses 422 and carries details', () => {
    const error = new ValidationError('invalid email', { field: 'email' });
    expect(error.statusCode).toBe(422);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details).toEqual({ field: 'email' });
  });

  it('NotFoundError encodes resource + identifier into details', () => {
    const error = new NotFoundError('Dispensary', 'd_abc');
    expect(error.statusCode).toBe(404);
    expect(error.details).toEqual({ resource: 'Dispensary', identifier: 'd_abc' });
    expect(error.message).toBe('Dispensary not found');
  });

  it('AuthError accepts only the documented codes', () => {
    const error = new AuthError('KYC_REQUIRED', 'KYC pending', { userId: 'u_1' });
    expect(error.code).toBe('KYC_REQUIRED');
    expect(error.statusCode).toBe(401);
    expect(error.details).toEqual({ userId: 'u_1' });
  });

  it('ComplianceError preserves the failing-rule code', () => {
    const error = new ComplianceError('COMPLIANCE_LIMIT_EXCEEDED', 'edible THC over 800mg', {
      limit_mg: 800,
      cart_mg: 950,
    });
    expect(error.code).toBe('COMPLIANCE_LIMIT_EXCEEDED');
    expect(error.statusCode).toBe(422);
    expect(error.details).toEqual({ limit_mg: 800, cart_mg: 950 });
  });

  it('PaymentError defaults to 402 but allows override', () => {
    const declined = new PaymentError('PAYMENT_DECLINED', 'declined');
    const provider = new PaymentError('PAYMENT_PROVIDER_UNAVAILABLE', 'aeropay down', {}, 503);
    expect(declined.statusCode).toBe(402);
    expect(provider.statusCode).toBe(503);
  });

  it('ExternalServiceError tags details with the service name', () => {
    const error = new ExternalServiceError('metrc', 'gateway timeout', { status: 504 });
    expect(error.details).toEqual({ service: 'metrc', status: 504 });
  });

  it('RepositoryError is a 500 with a stable code for ops alerting', () => {
    const error = new RepositoryError('orders insert returned no row', { table: 'orders' });
    expect(error.statusCode).toBe(500);
    expect(error.code).toBe('REPOSITORY_INVARIANT_VIOLATION');
    expect(error.details).toEqual({ table: 'orders' });
  });

  it('ConfigError is a 500 carrying a boot-time config code', () => {
    const error = new ConfigError('CONFIG_MISSING', 'JWT_PRIVATE_KEY_BASE64 not set', {
      variable: 'JWT_PRIVATE_KEY_BASE64',
    });
    expect(error.statusCode).toBe(500);
    expect(error.code).toBe('CONFIG_MISSING');
    expect(error.details).toEqual({ variable: 'JWT_PRIVATE_KEY_BASE64' });
  });

  it('preserves cause when provided (Node error chaining)', () => {
    const original = new Error('original');
    const wrapped = new ExternalServiceError('aeropay', 'wrapper', {}, original);
    expect(wrapped.cause).toBe(original);
  });

  it('captures its own stack frame (no constructor noise at the top)', () => {
    const error = new ValidationError('bad');
    expect(error.stack).toBeDefined();
    expect(error.stack?.split('\n')[1] ?? '').not.toMatch(/at new ValidationError/);
  });
});

describe('toErrorEnvelope', () => {
  it('produces the standard envelope shape', () => {
    const envelope = toErrorEnvelope(
      new ComplianceError('COMPLIANCE_LIMIT_EXCEEDED', 'over limit', { limit_mg: 800 }),
      'req_01HVK',
    );

    expect(envelope).toEqual({
      error: {
        code: 'COMPLIANCE_LIMIT_EXCEEDED',
        message: 'over limit',
        details: { limit_mg: 800 },
        request_id: 'req_01HVK',
      },
    });
  });

  it('omits request_id when not provided', () => {
    const envelope = toErrorEnvelope(new NotFoundError('Order', 'ord_404'));
    expect(envelope.error).not.toHaveProperty('request_id');
    expect(envelope.error.code).toBe('NOT_FOUND');
  });
});
