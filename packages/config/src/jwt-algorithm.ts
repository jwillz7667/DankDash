/**
 * Derives the JWS signing/verification algorithm from the configured
 * asymmetric key material.
 *
 * The access-token and checkout-handoff issuers are key-type-agnostic by
 * design: a deployment provisions an asymmetric keypair and the service
 * signs/verifies with the algorithm that matches the key it was actually
 * given. Hard-coding a single algorithm (the previous `RS256` constant)
 * meant an RSA-only assumption — provision an EC keypair (a perfectly valid,
 * common choice for JWT) and every token operation throws
 * `"alg" parameter for "ec" key type must be one of: ES256, ES384, ES512`,
 * taking authentication down across the API, the realtime service, and the
 * checkout hand-off.
 *
 * Deriving the algorithm from the key keeps the algorithm-confusion defence
 * fully intact: every verify path pins `algorithms` to the SINGLE asymmetric
 * algorithm returned here, so a forged token can never downgrade to an HMAC
 * family (HS256 using the public key as the shared secret) — only the one
 * asymmetric algorithm that matches the provisioned key is ever accepted.
 *
 *   RSA / RSA-PSS  -> RS256
 *   EC P-256       -> ES256
 *   EC P-384       -> ES384
 *   EC P-521       -> ES512
 *
 * The return type is the intersection of "asymmetric JWS algorithms" and the
 * algorithm union `jsonwebtoken` accepts, so the result drops straight into a
 * `SignOptions.algorithm` / `VerifyOptions.algorithms` without a cast. (EdDSA
 * is deliberately not supported — `jsonwebtoken@9`'s types do not list it, and
 * no deployment provisions an Ed25519 JWT key here.)
 */
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { ConfigError } from '@dankdash/types';

export type AsymmetricJwsAlgorithm = 'RS256' | 'ES256' | 'ES384' | 'ES512';

function algorithmForKeyObject(key: KeyObject): AsymmetricJwsAlgorithm {
  const keyType = key.asymmetricKeyType;
  switch (keyType) {
    case 'rsa':
    case 'rsa-pss':
      return 'RS256';
    case 'ec': {
      const curve = key.asymmetricKeyDetails?.namedCurve;
      switch (curve) {
        case 'prime256v1':
          return 'ES256';
        case 'secp384r1':
          return 'ES384';
        case 'secp521r1':
          return 'ES512';
        default:
          throw new ConfigError(
            'CONFIG_INVALID',
            `JWT EC key uses an unsupported curve for JWS signing: ${String(curve)} (expected one of prime256v1 / secp384r1 / secp521r1)`,
            { curve: String(curve) },
          );
      }
    }
    default:
      throw new ConfigError(
        'CONFIG_INVALID',
        `JWT key uses an unsupported type for JWS signing: ${String(keyType)} (expected rsa / ec / ed25519)`,
        { keyType: String(keyType) },
      );
  }
}

/**
 * Resolves the JWS algorithm for a PEM key. Tries the private-key parse
 * first (signing services hold the private key); falls back to the
 * public-key parse (verify-only services, e.g. realtime, hold only the
 * public half). Throws `ConfigError` for malformed or unsupported keys so
 * a misconfigured deployment fails fast at boot rather than 500-ing every
 * request at runtime.
 */
export function deriveJwsAlgorithm(pem: string): AsymmetricJwsAlgorithm {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    try {
      key = createPublicKey(pem);
    } catch (err) {
      throw new ConfigError(
        'CONFIG_INVALID',
        'JWT key material is neither a valid private nor public PEM key',
        {},
        err,
      );
    }
  }
  return algorithmForKeyObject(key);
}
