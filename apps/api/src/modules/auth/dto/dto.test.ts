/**
 * DTO schema tests. These exercise the Zod schemas directly (not through
 * the ZodValidationPipe) so failures surface as raw ZodError shape — the
 * pipe is tested separately. One acceptance + at least one rejection per
 * field that has a non-trivial constraint.
 */
import { describe, expect, it } from 'vitest';
import { LoginRequestSchema, LoginResponseSchema } from './login.dto.js';
import { LogoutRequestSchema } from './logout.dto.js';
import {
  MfaConfirmRequestSchema,
  MfaDisableRequestSchema,
  MfaSetupResponseSchema,
  MfaVerifyRequestSchema,
} from './mfa.dto.js';
import { RefreshRequestSchema, RefreshResponseSchema } from './refresh.dto.js';
import { RegisterRequestSchema, RegisterResponseSchema } from './register.dto.js';
import { TokenPairSchema } from './tokens.dto.js';
import { UserSummarySchema } from './user-summary.dto.js';

const SAMPLE_REGISTER = {
  email: 'JANE@example.COM',
  password: 'correct horse battery 9',
  phone: '+14155551234',
  dateOfBirth: '1995-05-18',
  firstName: 'Jane',
  lastName: 'Doe',
} as const;

describe('RegisterRequestSchema', () => {
  it('accepts a well-formed registration and lowercases + trims the email', () => {
    const parsed = RegisterRequestSchema.parse(SAMPLE_REGISTER);
    expect(parsed.email).toBe('jane@example.com');
    expect(parsed.firstName).toBe('Jane');
  });

  it('rejects passwords shorter than 12 characters', () => {
    expect(() => RegisterRequestSchema.parse({ ...SAMPLE_REGISTER, password: 'short1' })).toThrow(
      /at least 12/u,
    );
  });

  it('rejects passwords that are all letters (need at least one digit)', () => {
    expect(() =>
      RegisterRequestSchema.parse({ ...SAMPLE_REGISTER, password: 'abcdefghijklm' }),
    ).toThrow(/digit/u);
  });

  it('rejects passwords that are all digits (need at least one letter)', () => {
    expect(() =>
      RegisterRequestSchema.parse({ ...SAMPLE_REGISTER, password: '123456789012' }),
    ).toThrow(/letter/u);
  });

  it('rejects malformed email', () => {
    expect(() =>
      RegisterRequestSchema.parse({ ...SAMPLE_REGISTER, email: 'not-an-email' }),
    ).toThrow();
  });

  it('rejects non-E.164 phone formats', () => {
    expect(() =>
      RegisterRequestSchema.parse({ ...SAMPLE_REGISTER, phone: '415-555-1234' }),
    ).toThrow(/E\.164/u);
  });

  it('accepts a registration without phone (optional)', () => {
    const { phone: _phone, ...withoutPhone } = SAMPLE_REGISTER;
    expect(() => RegisterRequestSchema.parse(withoutPhone)).not.toThrow();
  });

  it('rejects dateOfBirth that is not YYYY-MM-DD', () => {
    expect(() =>
      RegisterRequestSchema.parse({ ...SAMPLE_REGISTER, dateOfBirth: '05/18/1995' }),
    ).toThrow(/YYYY-MM-DD/u);
  });

  it('rejects unknown fields via .strict()', () => {
    expect(() => RegisterRequestSchema.parse({ ...SAMPLE_REGISTER, ssn: '123-45-6789' })).toThrow();
  });
});

describe('LoginRequestSchema', () => {
  it('accepts email + password without mfaCode', () => {
    expect(() =>
      LoginRequestSchema.parse({ email: 'jane@example.com', password: 'whatever' }),
    ).not.toThrow();
  });

  it('accepts email + password + mfaCode', () => {
    const parsed = LoginRequestSchema.parse({
      email: 'jane@example.com',
      password: 'whatever',
      mfaCode: '123456',
    });
    expect(parsed.mfaCode).toBe('123456');
  });

  it('rejects mfaCode with non-numeric characters', () => {
    expect(() =>
      LoginRequestSchema.parse({
        email: 'jane@example.com',
        password: 'whatever',
        mfaCode: '12345a',
      }),
    ).toThrow(/6 digits/u);
  });

  it('rejects mfaCode of wrong length', () => {
    expect(() =>
      LoginRequestSchema.parse({
        email: 'jane@example.com',
        password: 'whatever',
        mfaCode: '12345',
      }),
    ).toThrow(/6 digits/u);
  });
});

describe('LoginResponseSchema', () => {
  it('accepts an mfa_required response', () => {
    const parsed = LoginResponseSchema.parse({
      status: 'mfa_required',
      challengeId: '01906c93-7ad0-7c5e-be19-9a8e0f37c4f8',
      challengeExpiresAt: '2026-05-18T12:05:00.000Z',
    });
    expect(parsed.status).toBe('mfa_required');
  });

  it('accepts an authenticated response', () => {
    const parsed = LoginResponseSchema.parse({
      status: 'authenticated',
      user: SAMPLE_USER,
      tokens: SAMPLE_TOKENS,
    });
    expect(parsed.status).toBe('authenticated');
  });

  it('rejects unknown status discriminants', () => {
    expect(() =>
      LoginResponseSchema.parse({
        status: 'whatever',
        user: SAMPLE_USER,
        tokens: SAMPLE_TOKENS,
      }),
    ).toThrow();
  });
});

describe('RefreshRequestSchema', () => {
  it('accepts a long opaque token', () => {
    const tok = 'a'.repeat(64);
    expect(() => RefreshRequestSchema.parse({ refreshToken: tok })).not.toThrow();
  });

  it('rejects suspiciously short tokens', () => {
    expect(() => RefreshRequestSchema.parse({ refreshToken: 'short' })).toThrow(/malformed/u);
  });

  it('rejects extra fields', () => {
    expect(() => RefreshRequestSchema.parse({ refreshToken: 'a'.repeat(64), extra: 1 })).toThrow();
  });
});

describe('LogoutRequestSchema', () => {
  it('accepts a refresh token', () => {
    expect(() => LogoutRequestSchema.parse({ refreshToken: 'a'.repeat(64) })).not.toThrow();
  });

  it('rejects short tokens', () => {
    expect(() => LogoutRequestSchema.parse({ refreshToken: 'x' })).toThrow();
  });
});

describe('MFA DTOs', () => {
  it('MfaSetupResponseSchema accepts a base32 secret + otpauth URL', () => {
    expect(() =>
      MfaSetupResponseSchema.parse({
        secretBase32: 'JBSWY3DPEHPK3PXP',
        otpauthUrl: 'otpauth://totp/DankDash:jane@example.com?secret=JBSWY3DPEHPK3PXP',
      }),
    ).not.toThrow();
  });

  it('MfaSetupResponseSchema rejects non-base32 chars in the secret', () => {
    expect(() =>
      MfaSetupResponseSchema.parse({
        secretBase32: 'lowercase-not-allowed',
        otpauthUrl: 'otpauth://totp/x',
      }),
    ).toThrow();
  });

  it('MfaConfirmRequestSchema accepts secret + 6-digit code', () => {
    const parsed = MfaConfirmRequestSchema.parse({
      secretBase32: 'JBSWY3DPEHPK3PXP',
      code: '123456',
    });
    expect(parsed.code).toBe('123456');
  });

  it('MfaConfirmRequestSchema rejects a 5-digit code', () => {
    expect(() =>
      MfaConfirmRequestSchema.parse({ secretBase32: 'JBSWY3DPEHPK3PXP', code: '12345' }),
    ).toThrow(/6 digits/u);
  });

  it('MfaVerifyRequestSchema rejects an alpha code', () => {
    expect(() => MfaVerifyRequestSchema.parse({ code: 'abcdef' })).toThrow(/6 digits/u);
  });

  it('MfaDisableRequestSchema rejects extra fields', () => {
    expect(() => MfaDisableRequestSchema.parse({ code: '123456', confirm: true })).toThrow();
  });
});

describe('TokenPairSchema + UserSummarySchema', () => {
  it('accepts a valid token pair', () => {
    expect(() => TokenPairSchema.parse(SAMPLE_TOKENS)).not.toThrow();
  });

  it('rejects token pairs without iso-offset timestamps', () => {
    expect(() =>
      TokenPairSchema.parse({ ...SAMPLE_TOKENS, accessTokenExpiresAt: 'not-a-date' }),
    ).toThrow();
  });

  it('accepts a complete user summary', () => {
    expect(() => UserSummarySchema.parse(SAMPLE_USER)).not.toThrow();
  });

  it('rejects an unknown role', () => {
    expect(() => UserSummarySchema.parse({ ...SAMPLE_USER, role: 'wizard' })).toThrow();
  });

  it('rejects an unknown status', () => {
    expect(() => UserSummarySchema.parse({ ...SAMPLE_USER, status: 'limbo' })).toThrow();
  });
});

describe('RegisterResponseSchema + RefreshResponseSchema', () => {
  it('RegisterResponseSchema accepts user + tokens', () => {
    expect(() =>
      RegisterResponseSchema.parse({ user: SAMPLE_USER, tokens: SAMPLE_TOKENS }),
    ).not.toThrow();
  });

  it('RefreshResponseSchema accepts just tokens', () => {
    expect(() => RefreshResponseSchema.parse({ tokens: SAMPLE_TOKENS })).not.toThrow();
  });
});

const SAMPLE_TOKENS = {
  accessToken: 'header.payload.signature',
  refreshToken: 'a'.repeat(64),
  accessTokenExpiresAt: '2026-05-18T12:15:00.000Z',
  refreshTokenExpiresAt: '2026-06-18T12:00:00.000Z',
  tokenType: 'Bearer',
} as const;

const SAMPLE_USER = {
  id: '01906c93-7ad0-7c5e-be19-9a8e0f37c4f8',
  email: 'jane@example.com',
  phone: '+14155551234',
  firstName: 'Jane',
  lastName: 'Doe',
  role: 'customer',
  status: 'active',
  kycVerified: true,
  mfaEnabled: false,
  createdAt: '2026-01-01T00:00:00.000Z',
} as const;
