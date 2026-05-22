/**
 * Realtime-service JWT verifier.
 *
 * Re-implements (rather than re-uses) the apps/api JwtService because the
 * realtime service is intentionally non-NestJS: it has no DI container,
 * no @nestjs/common types, and we do not want to drag the API's full
 * module tree into the realtime pod's bundle just to verify a token.
 *
 * The verification rules are identical to apps/api/src/modules/auth/jwt
 * — RS256 only (algorithm-confusion guard), explicit issuer + audience,
 * 30s clock-skew tolerance. Drift between the two surfaces would be a
 * latent auth bypass, so the constants below mirror the API's defaults
 * and the test asserts that a token issued by the API verifies here.
 */
import { AuthError, ConfigError } from '@dankdash/types';
import jwt, { type Algorithm } from 'jsonwebtoken';

export interface RealtimeJwtConfig {
  readonly publicKeyPem: string;
  readonly issuer?: string;
  readonly audience?: string;
}

export interface RealtimeAccessTokenClaims {
  readonly sub: string;
  readonly sid: string;
  readonly role: string;
  readonly iss: string;
  readonly aud: string;
  readonly iat: number;
  readonly exp: number;
}

const DEFAULT_ISSUER = 'dankdash';
const DEFAULT_AUDIENCE = 'dankdash.app';
const CLOCK_SKEW_SECONDS = 30;
const ALGORITHM: Algorithm = 'RS256';

export class RealtimeJwtVerifier {
  private readonly publicKey: string;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(config: RealtimeJwtConfig) {
    this.publicKey = config.publicKeyPem;
    this.issuer = config.issuer ?? DEFAULT_ISSUER;
    this.audience = config.audience ?? DEFAULT_AUDIENCE;
  }

  verify(token: string): RealtimeAccessTokenClaims {
    try {
      const decoded = jwt.verify(token, this.publicKey, {
        algorithms: [ALGORITHM],
        issuer: this.issuer,
        audience: this.audience,
        clockTolerance: CLOCK_SKEW_SECONDS,
        complete: false,
      });
      if (typeof decoded === 'string') {
        throw new AuthError('TOKEN_INVALID', 'token payload is not a json object');
      }
      const claims = decoded as Record<string, unknown>;
      const sub = claims['sub'];
      const sid = claims['sid'];
      const role = claims['role'];
      const iat = claims['iat'];
      const exp = claims['exp'];
      if (
        typeof sub !== 'string' ||
        typeof sid !== 'string' ||
        typeof role !== 'string' ||
        typeof iat !== 'number' ||
        typeof exp !== 'number'
      ) {
        throw new AuthError('TOKEN_INVALID', 'token claims are malformed');
      }
      return {
        sub,
        sid,
        role,
        iss: this.issuer,
        aud: this.audience,
        iat,
        exp,
      };
    } catch (err) {
      if (err instanceof AuthError) throw err;
      if (err instanceof jwt.TokenExpiredError) {
        throw new AuthError('TOKEN_EXPIRED', 'access token has expired', {}, err);
      }
      if (err instanceof jwt.NotBeforeError) {
        throw new AuthError('TOKEN_INVALID', 'access token not yet valid', {}, err);
      }
      throw new AuthError('TOKEN_INVALID', 'access token verification failed', {}, err);
    }
  }
}

/**
 * Decodes a base64-encoded PEM into the raw PEM string the verifier
 * expects. Errors carry context so a bad env var produces a useful
 * boot failure rather than a cryptic "PEM_read_bio" deep in jsonwebtoken.
 */
export function decodePublicKey(base64Pem: string): string {
  const pem = Buffer.from(base64Pem, 'base64').toString('utf-8');
  if (!pem.includes('BEGIN PUBLIC KEY') && !pem.includes('BEGIN RSA PUBLIC KEY')) {
    throw new ConfigError(
      'CONFIG_INVALID',
      'JWT_PUBLIC_KEY_BASE64 must decode to a PEM-formatted RSA public key',
    );
  }
  return pem;
}
