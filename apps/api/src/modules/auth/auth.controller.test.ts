/**
 * Unit tests for AuthController.
 *
 * The controller is a thin adapter between Fastify and AuthService; what we
 * want to lock down here is the wiring — that each route hands the right
 * fields to the service in the right shape. We instantiate it directly with
 * a fake AuthService rather than spinning the Nest container; the
 * integration suite (test/integration/auth.routes.test.ts, future) is the
 * place that verifies guards/pipes/filters.
 *
 * The `requestContext` helper at the file footer extracts {ipAddress,
 * userAgent} from a FastifyRequest — exercising it here pins the contract
 * the service depends on (audit-trail rows are written from these values).
 */
import { describe, expect, it } from 'vitest';
import { AuthController } from './auth.controller.js';
import type { AuthService, AuthRequestContext } from './auth.service.js';
import type {
  LoginRequestDto,
  LoginResponse,
  LogoutRequestDto,
  MfaConfirmRequestDto,
  MfaDisableRequestDto,
  MfaSetupResponse,
  MfaVerifyRequestDto,
  RefreshRequestDto,
  RefreshResponse,
  RegisterRequestDto,
  RegisterResponse,
} from './dto/index.js';
import type { AuthenticatedUser } from './guards/auth-types.js';
import type { FastifyRequest } from 'fastify';

const USER: AuthenticatedUser = {
  userId: '01935f3d-0000-7000-8000-000000000001',
  sessionId: '01935f3d-0000-7000-8000-000000000099',
  role: 'customer',
};

const TOKENS = {
  accessToken: 'access.jwt.token',
  refreshToken: 'opaque-refresh-token',
  accessTokenExpiresAt: '2026-05-18T18:00:00.000+00:00',
  refreshTokenExpiresAt: '2026-05-25T18:00:00.000+00:00',
  tokenType: 'Bearer' as const,
};

const USER_SUMMARY = {
  id: USER.userId,
  email: 'jane@example.com',
  phone: '+16125550100',
  firstName: 'Jane',
  lastName: 'Doe',
  role: 'customer' as const,
  status: 'pending_kyc' as const,
  kycVerified: false,
  mfaEnabled: false,
  createdAt: '2026-05-01T00:00:00.000+00:00',
};

class FakeAuthService {
  readonly calls = {
    register: [] as Array<{ body: RegisterRequestDto; ctx: AuthRequestContext }>,
    login: [] as Array<{ body: LoginRequestDto; ctx: AuthRequestContext }>,
    refreshTokens: [] as Array<{ refreshToken: string; ctx: AuthRequestContext }>,
    logout: [] as string[],
    startMfaEnrollment: [] as string[],
    confirmMfaEnrollment: [] as Array<{ userId: string; secret: string; code: string }>,
    verifyMfaCode: [] as Array<{ userId: string; code: string }>,
    disableMfa: [] as Array<{ userId: string; code: string }>,
  };

  register = (body: RegisterRequestDto, ctx: AuthRequestContext): Promise<RegisterResponse> => {
    this.calls.register.push({ body, ctx });
    return Promise.resolve({ user: USER_SUMMARY, tokens: TOKENS });
  };

  login = (body: LoginRequestDto, ctx: AuthRequestContext): Promise<LoginResponse> => {
    this.calls.login.push({ body, ctx });
    return Promise.resolve({ status: 'authenticated', user: USER_SUMMARY, tokens: TOKENS });
  };

  refreshTokens = (refreshToken: string, ctx: AuthRequestContext): Promise<RefreshResponse> => {
    this.calls.refreshTokens.push({ refreshToken, ctx });
    return Promise.resolve({ tokens: TOKENS });
  };

  logout = (refreshToken: string): Promise<void> => {
    this.calls.logout.push(refreshToken);
    return Promise.resolve();
  };

  startMfaEnrollment = (userId: string): Promise<MfaSetupResponse> => {
    this.calls.startMfaEnrollment.push(userId);
    return Promise.resolve({
      secretBase32: 'JBSWY3DPEHPK3PXP',
      otpauthUrl:
        'otpauth://totp/DankDash:jane@example.com?secret=JBSWY3DPEHPK3PXP&issuer=DankDash',
    });
  };

  confirmMfaEnrollment = (userId: string, secret: string, code: string): Promise<void> => {
    this.calls.confirmMfaEnrollment.push({ userId, secret, code });
    return Promise.resolve();
  };

  verifyMfaCode = (userId: string, code: string): Promise<void> => {
    this.calls.verifyMfaCode.push({ userId, code });
    return Promise.resolve();
  };

  disableMfa = (userId: string, code: string): Promise<void> => {
    this.calls.disableMfa.push({ userId, code });
    return Promise.resolve();
  };
}

function makeRequest(ip: string, userAgent?: string): FastifyRequest {
  // Cast at the construction site: FastifyRequest carries route-generic
  // type parameters the controller never reads. The shape the controller
  // touches is narrow — `ip` and `headers['user-agent']` — and that is what
  // we satisfy here.
  return {
    ip,
    headers: userAgent === undefined ? {} : { 'user-agent': userAgent },
  } as unknown as FastifyRequest;
}

describe('AuthController', () => {
  const buildController = (): { controller: AuthController; auth: FakeAuthService } => {
    const auth = new FakeAuthService();
    const controller = new AuthController(auth as unknown as AuthService);
    return { controller, auth };
  };

  it('register forwards body + extracts ip and user-agent', async () => {
    const { controller, auth } = buildController();
    const body: RegisterRequestDto = {
      email: 'jane@example.com',
      phone: '+16125550100',
      password: 'Sup3rStr0ng!Pass',
      firstName: 'Jane',
      lastName: 'Doe',
      dateOfBirth: '1990-01-15',
    };
    const req = makeRequest('203.0.113.7', 'DankDashApp/1.0');

    const res = await controller.register(body, req);

    expect(res.user.email).toBe('jane@example.com');
    expect(auth.calls.register).toHaveLength(1);
    expect(auth.calls.register[0]?.body).toBe(body);
    expect(auth.calls.register[0]?.ctx).toEqual({
      ipAddress: '203.0.113.7',
      userAgent: 'DankDashApp/1.0',
    });
  });

  it('register omits ipAddress when req.ip is empty', async () => {
    const { controller, auth } = buildController();
    const body: RegisterRequestDto = {
      email: 'jane@example.com',
      phone: '+16125550100',
      password: 'Sup3rStr0ng!Pass',
      firstName: 'Jane',
      lastName: 'Doe',
      dateOfBirth: '1990-01-15',
    };

    await controller.register(body, makeRequest(''));

    expect(auth.calls.register[0]?.ctx).toEqual({});
  });

  it('login forwards body and threads request context', async () => {
    const { controller, auth } = buildController();
    const body: LoginRequestDto = { email: 'jane@example.com', password: 'Sup3rStr0ng!Pass' };

    const res = await controller.login(body, makeRequest('203.0.113.8', 'TestAgent/2.0'));

    expect(res).toMatchObject({ status: 'authenticated' });
    expect(auth.calls.login[0]?.body).toBe(body);
    expect(auth.calls.login[0]?.ctx.ipAddress).toBe('203.0.113.8');
  });

  it('refresh hands the refreshToken (not the whole body) to the service', async () => {
    const { controller, auth } = buildController();
    const body: RefreshRequestDto = { refreshToken: 'opaque-refresh-token-aaa' };

    const res = await controller.refresh(body, makeRequest('203.0.113.9'));

    expect(res.tokens.accessToken).toBe(TOKENS.accessToken);
    expect(auth.calls.refreshTokens).toHaveLength(1);
    expect(auth.calls.refreshTokens[0]?.refreshToken).toBe('opaque-refresh-token-aaa');
  });

  it('logout passes the refresh token through and returns void', async () => {
    const { controller, auth } = buildController();
    const body: LogoutRequestDto = { refreshToken: 'opaque-refresh-token-zzz' };

    await expect(controller.logout(body)).resolves.toBeUndefined();
    expect(auth.calls.logout).toEqual(['opaque-refresh-token-zzz']);
  });

  it('mfaSetup pulls userId from the @CurrentUser claim', async () => {
    const { controller, auth } = buildController();

    const res = await controller.mfaSetup(USER);

    expect(res.secretBase32).toBe('JBSWY3DPEHPK3PXP');
    expect(auth.calls.startMfaEnrollment).toEqual([USER.userId]);
  });

  it('mfaConfirm forwards secret + code with the user id', async () => {
    const { controller, auth } = buildController();
    const body: MfaConfirmRequestDto = { secretBase32: 'JBSWY3DPEHPK3PXP', code: '123456' };

    await expect(controller.mfaConfirm(USER, body)).resolves.toBeUndefined();
    expect(auth.calls.confirmMfaEnrollment).toEqual([
      { userId: USER.userId, secret: 'JBSWY3DPEHPK3PXP', code: '123456' },
    ]);
  });

  it('mfaVerify passes code through with the user id', async () => {
    const { controller, auth } = buildController();
    const body: MfaVerifyRequestDto = { code: '654321' };

    await expect(controller.mfaVerify(USER, body)).resolves.toBeUndefined();
    expect(auth.calls.verifyMfaCode).toEqual([{ userId: USER.userId, code: '654321' }]);
  });

  it('mfaDisable requires a current code (forwarded to the service)', async () => {
    const { controller, auth } = buildController();
    const body: MfaDisableRequestDto = { code: '012345' };

    await expect(controller.mfaDisable(USER, body)).resolves.toBeUndefined();
    expect(auth.calls.disableMfa).toEqual([{ userId: USER.userId, code: '012345' }]);
  });
});
