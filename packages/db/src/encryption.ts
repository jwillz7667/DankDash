/**
 * Column-level encryption helper for Restricted data class (per spec §8.1).
 *
 * Threat model: a DBA with raw read access to Postgres must not be able to
 * decrypt protected columns. The master key lives only in the application
 * process (loaded from `COLUMN_ENCRYPTION_KEY_BASE64`); the database stores
 * opaque bytea blobs.
 *
 * Cryptographic construction: envelope encryption with AES-256-GCM.
 *   1. A fresh 32-byte Data Encryption Key (DEK) is generated per value.
 *   2. The plaintext is encrypted with the DEK (random 96-bit IV + 128-bit
 *      auth tag).
 *   3. The DEK itself is wrapped (encrypted) under the master Key Encryption
 *      Key (KEK) with its own IV + auth tag.
 *   4. Caller-supplied `context` (e.g. "users.mfa_secret_enc") is bound to
 *      BOTH the data ciphertext and the key wrap as Additional Authenticated
 *      Data — swapping a wrapped DEK across columns or substituting cipher
 *      text from another column fails authentication. Pick a stable, unique
 *      string per column; renaming a context is a hard rotation.
 *
 * Wire format (single bytea column, network-order fixed-size header):
 *   offset  bytes  field
 *   ------  -----  --------------------------------------------------------
 *   0       1      version byte (currently 0x01)
 *   1       12     DEK IV
 *   13      16     DEK auth tag
 *   29      32     wrapped DEK (encrypted with KEK)
 *   61      12     data IV
 *   73      16     data auth tag
 *   89      N      ciphertext (same length as plaintext under GCM)
 *
 * Total overhead: 89 bytes per value, regardless of plaintext size.
 *
 * Rotation strategy: the version byte at offset 0 reserves room for future
 * formats (e.g. v2 with a key ID for KEK rotation). Today only v1 is emitted;
 * the decoder rejects unknown versions explicitly. When a new KEK is needed,
 * introduce v2, dual-decrypt during rollout, and re-encrypt at rest in a
 * backfill job.
 */
import { createCipheriv, createDecipheriv, randomBytes, type CipherGCMTypes } from 'node:crypto';
import { EncryptionError } from '@dankdash/types';

const ALGORITHM: CipherGCMTypes = 'aes-256-gcm';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // 96-bit IV recommended for GCM (NIST SP 800-38D §8.2)
const AUTH_TAG_BYTES = 16; // 128-bit GCM tag
const VERSION_V1 = 0x01;

const DEK_IV_OFFSET = 1;
const DEK_TAG_OFFSET = DEK_IV_OFFSET + IV_BYTES;
const WRAPPED_DEK_OFFSET = DEK_TAG_OFFSET + AUTH_TAG_BYTES;
const DATA_IV_OFFSET = WRAPPED_DEK_OFFSET + KEY_BYTES;
const DATA_TAG_OFFSET = DATA_IV_OFFSET + IV_BYTES;
const CIPHERTEXT_OFFSET = DATA_TAG_OFFSET + AUTH_TAG_BYTES;
const HEADER_BYTES = CIPHERTEXT_OFFSET;

export interface EncryptionService {
  /**
   * Encrypt a UTF-8 string. `context` is bound to the ciphertext as AAD —
   * decrypting with a different context fails as if the ciphertext were
   * tampered. Pick a stable per-column identifier such as
   * `"users.mfa_secret_enc"`.
   */
  encryptString(plaintext: string, context: string): Uint8Array;
  /** Decrypt a string produced by {@link encryptString}. */
  decryptString(ciphertext: Uint8Array, context: string): string;
  /** Encrypt arbitrary bytes; see {@link encryptString} for AAD semantics. */
  encryptBytes(plaintext: Uint8Array, context: string): Uint8Array;
  /** Decrypt bytes produced by {@link encryptBytes}. */
  decryptBytes(ciphertext: Uint8Array, context: string): Uint8Array;
}

export interface CreateEncryptionServiceOptions {
  /** 32-byte master Key Encryption Key. Treat as Restricted. */
  readonly masterKey: Uint8Array;
}

export function createEncryptionService(opts: CreateEncryptionServiceOptions): EncryptionService {
  const masterKey = Buffer.from(opts.masterKey);
  if (masterKey.length !== KEY_BYTES) {
    throw new EncryptionError(
      'ENCRYPTION_CONFIG_INVALID',
      `Master key must be ${KEY_BYTES} bytes; got ${masterKey.length}`,
      { expectedBytes: KEY_BYTES, actualBytes: masterKey.length },
    );
  }

  function encryptBytes(plaintext: Uint8Array, context: string): Uint8Array {
    if (context.length === 0) {
      throw new EncryptionError(
        'ENCRYPTION_CONFIG_INVALID',
        'Context (AAD) must be a non-empty string',
      );
    }
    const contextBytes = Buffer.from(context, 'utf8');
    const plaintextBuf = Buffer.from(plaintext);

    const dek = randomBytes(KEY_BYTES);
    const dataIv = randomBytes(IV_BYTES);
    const dataCipher = createCipheriv(ALGORITHM, dek, dataIv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    dataCipher.setAAD(contextBytes);
    const ciphertext = Buffer.concat([dataCipher.update(plaintextBuf), dataCipher.final()]);
    const dataTag = dataCipher.getAuthTag();

    const dekIv = randomBytes(IV_BYTES);
    const keyCipher = createCipheriv(ALGORITHM, masterKey, dekIv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    // Bind the same context to the key wrap — swapping wrapped DEKs across
    // columns is detected even if both columns happened to be encrypted
    // under the same KEK.
    keyCipher.setAAD(contextBytes);
    const wrappedDek = Buffer.concat([keyCipher.update(dek), keyCipher.final()]);
    const dekTag = keyCipher.getAuthTag();

    const out = Buffer.alloc(HEADER_BYTES + ciphertext.length);
    out.writeUInt8(VERSION_V1, 0);
    dekIv.copy(out, DEK_IV_OFFSET);
    dekTag.copy(out, DEK_TAG_OFFSET);
    wrappedDek.copy(out, WRAPPED_DEK_OFFSET);
    dataIv.copy(out, DATA_IV_OFFSET);
    dataTag.copy(out, DATA_TAG_OFFSET);
    ciphertext.copy(out, CIPHERTEXT_OFFSET);
    return new Uint8Array(out);
  }

  function decryptBytes(ciphertext: Uint8Array, context: string): Uint8Array {
    if (context.length === 0) {
      throw new EncryptionError(
        'ENCRYPTION_CONFIG_INVALID',
        'Context (AAD) must be a non-empty string',
      );
    }
    if (ciphertext.length < HEADER_BYTES) {
      throw new EncryptionError(
        'DECRYPTION_FAILED',
        `Ciphertext too short: expected at least ${HEADER_BYTES} bytes, got ${ciphertext.length}`,
        { length: ciphertext.length, minimum: HEADER_BYTES },
      );
    }
    const buf = Buffer.from(ciphertext);
    const version = buf.readUInt8(0);
    if (version !== VERSION_V1) {
      throw new EncryptionError(
        'DECRYPTION_FAILED',
        `Unsupported envelope version: 0x${version.toString(16).padStart(2, '0')}`,
        { version },
      );
    }
    const contextBytes = Buffer.from(context, 'utf8');
    const dekIv = buf.subarray(DEK_IV_OFFSET, DEK_IV_OFFSET + IV_BYTES);
    const dekTag = buf.subarray(DEK_TAG_OFFSET, DEK_TAG_OFFSET + AUTH_TAG_BYTES);
    const wrappedDek = buf.subarray(WRAPPED_DEK_OFFSET, WRAPPED_DEK_OFFSET + KEY_BYTES);
    const dataIv = buf.subarray(DATA_IV_OFFSET, DATA_IV_OFFSET + IV_BYTES);
    const dataTag = buf.subarray(DATA_TAG_OFFSET, DATA_TAG_OFFSET + AUTH_TAG_BYTES);
    const payload = buf.subarray(CIPHERTEXT_OFFSET);

    let dek: Buffer;
    try {
      const keyDecipher = createDecipheriv(ALGORITHM, masterKey, dekIv, {
        authTagLength: AUTH_TAG_BYTES,
      });
      keyDecipher.setAuthTag(dekTag);
      keyDecipher.setAAD(contextBytes);
      dek = Buffer.concat([keyDecipher.update(wrappedDek), keyDecipher.final()]);
    } catch (cause) {
      throw new EncryptionError(
        'DECRYPTION_FAILED',
        'Key unwrap failed (wrong master key, tampered envelope, or wrong context)',
        {},
        cause,
      );
    }

    try {
      const dataDecipher = createDecipheriv(ALGORITHM, dek, dataIv, {
        authTagLength: AUTH_TAG_BYTES,
      });
      dataDecipher.setAuthTag(dataTag);
      dataDecipher.setAAD(contextBytes);
      const plaintext = Buffer.concat([dataDecipher.update(payload), dataDecipher.final()]);
      return new Uint8Array(plaintext);
    } catch (cause) {
      throw new EncryptionError(
        'DECRYPTION_FAILED',
        'Ciphertext authentication failed (tampered ciphertext or wrong context)',
        {},
        cause,
      );
    }
  }

  function encryptString(plaintext: string, context: string): Uint8Array {
    return encryptBytes(Buffer.from(plaintext, 'utf8'), context);
  }

  function decryptString(ciphertext: Uint8Array, context: string): string {
    const bytes = decryptBytes(ciphertext, context);
    return Buffer.from(bytes).toString('utf8');
  }

  return Object.freeze({ encryptBytes, decryptBytes, encryptString, decryptString });
}

/**
 * Build an {@link EncryptionService} from a base64-encoded 32-byte master
 * key — convenience wrapper around the env var
 * `COLUMN_ENCRYPTION_KEY_BASE64`.
 */
export function createEncryptionServiceFromBase64(base64Key: string): EncryptionService {
  const decoded = Buffer.from(base64Key, 'base64');
  return createEncryptionService({ masterKey: new Uint8Array(decoded) });
}

/** Generate a fresh base64-encoded 32-byte master key (for bootstrap / docs). */
export function generateMasterKeyBase64(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

/**
 * Stable list of column AAD contexts used across the codebase. Adding a row
 * here is the only place where new encrypted columns should be registered —
 * keeps the universe of contexts auditable in one file.
 */
export const ENCRYPTION_CONTEXT = Object.freeze({
  USER_MFA_SECRET: 'users.mfa_secret_enc',
  DISPENSARY_METRC_API_KEY: 'dispensaries.metrc_api_key_enc',
  DISPENSARY_POS_CREDENTIALS: 'dispensaries.pos_credentials_enc',
} as const);

export type EncryptionContext = (typeof ENCRYPTION_CONTEXT)[keyof typeof ENCRYPTION_CONTEXT];
