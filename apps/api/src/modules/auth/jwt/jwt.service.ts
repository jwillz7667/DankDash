/**
 * Access-token issuer / verifier.
 *
 * Algorithm: RS256 (asymmetric) so future services (realtime, workers,
 * external partners) can verify tokens with just the public key without
 * being able to mint them. The key pair is held in env as base64 PEM:
 *
 *   JWT_PRIVATE_KEY_BASE64  →  signs new tokens (api only)
 *   JWT_PUBLIC_KEY_BASE64   →  verifies tokens (every service)
 *
 * Claims (matches spec §4.2):
 *   sub  — user id (UUIDv7)
 *   sid  — session id (UUIDv7) — ties token to a refresh-token chain
 *   role — primary role at issue time (manager / driver / customer / ...)
 *   iss  — "dankdash"
 *   aud  — "dankdash.app" (single audience for now; extend on partner API)
 *   kid  — key id, prepares for rotation by indexing future keys
 *   iat / exp — standard
 *
 * Verification is strict: explicit `algorithms: ['RS256']` to prevent
 * algorithm-confusion attacks (HS256 forgery using the public key as the
 * HMAC secret is the classic example). Clock skew tolerance is 30s.
 */
import { AuthError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import jwt, { type Algorithm, type SignOptions } from 'jsonwebtoken';

export interface JwtServiceConfig {
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
  readonly accessTtlSeconds: number;
  readonly issuer?: string;
  readonly audience?: string;
  readonly keyId?: string;
}

export interface AccessTokenClaims {
  readonly sub: string;
  readonly sid: string;
  readonly role: string;
  readonly iss: string;
  readonly aud: string;
  readonly iat: number;
  readonly exp: number;
  readonly kid: string;
}

export interface IssueAccessTokenInput {
  readonly userId: string;
  readonly sessionId: string;
  readonly role: string;
}

const DEFAULT_ISSUER = 'dankdash';
const DEFAULT_AUDIENCE = 'dankdash.app';
const DEFAULT_KEY_ID = 'v1';
const CLOCK_SKEW_SECONDS = 30;
const ALGORITHM: Algorithm = 'RS256';

@Injectable()
export class JwtService {
  private readonly privateKey: string;
  private readonly publicKey: string;
  private readonly accessTtl: number;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly keyId: string;

  constructor(config: JwtServiceConfig) {
    this.privateKey = config.privateKeyPem;
    this.publicKey = config.publicKeyPem;
    this.accessTtl = config.accessTtlSeconds;
    this.issuer = config.issuer ?? DEFAULT_ISSUER;
    this.audience = config.audience ?? DEFAULT_AUDIENCE;
    this.keyId = config.keyId ?? DEFAULT_KEY_ID;
  }

  signAccessToken(input: IssueAccessTokenInput): string {
    const options: SignOptions = {
      algorithm: ALGORITHM,
      expiresIn: this.accessTtl,
      issuer: this.issuer,
      audience: this.audience,
      keyid: this.keyId,
      subject: input.userId,
    };
    return jwt.sign({ sid: input.sessionId, role: input.role }, this.privateKey, options);
  }

  /**
   * Verifies signature, issuer, audience, exp/iat with 30s skew. Returns
   * the typed claims on success. Translates jsonwebtoken's mix of error
   * shapes into a single typed AuthError surface that the global filter
   * already knows how to render.
   */
  verifyAccessToken(token: string): AccessTokenClaims {
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
        kid: this.keyId,
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
