/**
 * Cloudflare R2 (S3-compatible) object-storage adapter.
 *
 * Why a wrapper rather than handing `S3Client` around the codebase:
 *   - Centralizes endpoint and credential plumbing so consumers never need to
 *     know about `region: 'auto'` or the R2 endpoint shape.
 *   - Forces consistent error mapping: every upstream failure becomes
 *     `ExternalServiceError` (rendered as 502 by the API filter) — an
 *     unwrapped AWS SDK error must never reach the client.
 *   - Keeps the AWS SDK off the public type surface of consumer packages so
 *     swapping providers (or upgrading the SDK) is a one-package change.
 *
 * Two presign variants are exposed:
 *   - `presignUpload` builds a presigned POST policy for browser/mobile direct
 *     uploads. The policy locks content type and length-range so the client
 *     cannot upload arbitrary garbage.
 *   - `presignDownload` builds a presigned GET URL for restricted assets
 *     (COAs visible only to vendors/admins, ID scans visible only to
 *     compliance officers).
 *
 * Public assets (product images, dispensary logos) use `getPublicUrl` against
 * a configured `R2_PUBLIC_BASE_URL` (a Cloudflare custom domain or pub-*.r2.dev
 * URL). Buckets without a configured public URL throw `ConfigError` to fail
 * fast — there is no fallback to presigned URLs because that would silently
 * leak rate limits and cache misses.
 *
 * Key validation is intentional: empty strings and leading slashes are
 * caller bugs (typically string concatenation gone wrong) that would
 * otherwise produce silently-bad object names. Reject them at the boundary.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ConfigError, ExternalServiceError, ValidationError } from '@dankdash/types';
import type { Readable } from 'node:stream';

/**
 * Configuration for a single R2 bucket.
 *
 * `accountId` is the Cloudflare account ID; the R2 endpoint is derived as
 * `https://<accountId>.r2.cloudflarestorage.com`.
 *
 * `publicBaseUrl` is optional — set it when the bucket is served via a
 * public domain. Restricted asset buckets (COAs, ID scans) omit it and
 * are only accessed via presigned downloads.
 */
export interface R2Config {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  readonly publicBaseUrl?: string;
}

/**
 * Result of {@link R2Storage.presignUpload}. The client POSTs a multipart
 * form to `url` with every entry in `fields` populated and the file body
 * in a `file` field appended last.
 *
 * `expiresAt` is the wall-clock time at which the underlying policy stops
 * being accepted by R2; surface it to the client so the UI can re-request
 * a fresh URL before it lapses.
 */
export interface PresignedUpload {
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface PresignUploadOptions {
  /** Object key (no leading slash, non-empty). */
  readonly key: string;
  /** Required Content-Type the upload must declare; locked in the policy. */
  readonly contentType: string;
  /** Maximum allowed upload size in bytes; enforced server-side by R2. */
  readonly contentLengthMax: number;
  /** Lifetime of the presigned POST policy. Defaults to 300 (5 minutes). */
  readonly expiresInSec?: number;
}

const DEFAULT_PRESIGN_TTL_SEC = 300;
const SERVICE_NAME = 'cloudflare-r2';

export class R2Storage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string | null;

  constructor(config: R2Config) {
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      // R2 supports both virtual-hosted and path-style; pin path-style for
      // deterministic URLs and to avoid DNS-resolution issues with buckets
      // that contain characters not permitted in subdomains.
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    this.bucket = config.bucket;
    this.publicBaseUrl =
      config.publicBaseUrl !== undefined ? config.publicBaseUrl.replace(/\/+$/, '') : null;
  }

  async presignUpload(opts: PresignUploadOptions): Promise<PresignedUpload> {
    this.assertKey(opts.key);
    if (!Number.isFinite(opts.contentLengthMax) || opts.contentLengthMax <= 0) {
      throw new ValidationError('contentLengthMax must be a positive number', {
        contentLengthMax: opts.contentLengthMax,
      });
    }
    const expiresInSec = opts.expiresInSec ?? DEFAULT_PRESIGN_TTL_SEC;
    const expiresAt = new Date(Date.now() + expiresInSec * 1000);

    try {
      const post = await createPresignedPost(this.client, {
        Bucket: this.bucket,
        Key: opts.key,
        Conditions: [
          ['content-length-range', 1, opts.contentLengthMax],
          { 'Content-Type': opts.contentType },
        ],
        Fields: { 'Content-Type': opts.contentType },
        Expires: expiresInSec,
      });
      return { url: post.url, fields: post.fields, expiresAt };
    } catch (cause) {
      throw new ExternalServiceError(
        SERVICE_NAME,
        'failed to create presigned upload',
        { key: opts.key },
        cause,
      );
    }
  }

  async presignDownload(key: string, expiresInSec?: number): Promise<string> {
    this.assertKey(key);
    const ttl = expiresInSec ?? DEFAULT_PRESIGN_TTL_SEC;
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn: ttl },
      );
    } catch (cause) {
      throw new ExternalServiceError(
        SERVICE_NAME,
        'failed to create presigned download URL',
        { key },
        cause,
      );
    }
  }

  getPublicUrl(key: string): string {
    this.assertKey(key);
    if (this.publicBaseUrl === null) {
      throw new ConfigError(
        'CONFIG_MISSING',
        'R2_PUBLIC_BASE_URL is not configured — this bucket has no public URL',
        { bucket: this.bucket },
      );
    }
    return `${this.publicBaseUrl}/${key}`;
  }

  /**
   * Server-side single-shot upload for in-memory bodies (≤5MB-ish). Use
   * {@link putObjectStream} for larger payloads — multipart streaming
   * avoids the heap pressure of buffering the whole object.
   *
   * `contentType` is optional but recommended: it ends up in the object
   * metadata and influences downstream consumers (browser sniffing,
   * analytics crawlers that filter by Content-Type, etc.).
   */
  async putObject(
    key: string,
    body: Buffer | Uint8Array | string,
    contentType?: string,
  ): Promise<void> {
    this.assertKey(key);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    } catch (cause) {
      throw new ExternalServiceError(SERVICE_NAME, 'failed to put object', { key }, cause);
    }
  }

  /**
   * Server-side streamed upload. Wraps `@aws-sdk/lib-storage` `Upload`
   * which transparently performs multipart uploads of 5MB chunks with
   * up to 4 in-flight at once — that's the right shape for archives
   * we'd otherwise have to buffer (week-long location partitions land
   * around 150–300MB Parquet).
   *
   * Caller passes a node Readable; this method drives it to completion
   * and resolves once R2 has acknowledged every part. Errors during the
   * upload (network, 5xx) propagate as `ExternalServiceError`.
   */
  async putObjectStream(key: string, body: Readable, contentType?: string): Promise<void> {
    this.assertKey(key);
    try {
      const upload = new Upload({
        client: this.client,
        params: {
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        },
      });
      await upload.done();
    } catch (cause) {
      throw new ExternalServiceError(SERVICE_NAME, 'failed to stream object to R2', { key }, cause);
    }
  }

  async deleteObject(key: string): Promise<void> {
    this.assertKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (cause) {
      throw new ExternalServiceError(SERVICE_NAME, 'failed to delete object', { key }, cause);
    }
  }

  async objectExists(key: string): Promise<boolean> {
    this.assertKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (isNotFoundError(err)) return false;
      throw new ExternalServiceError(
        SERVICE_NAME,
        'failed to check object existence',
        { key },
        err,
      );
    }
  }

  private assertKey(key: string): void {
    if (key.length === 0) {
      throw new ValidationError('object key must be a non-empty string');
    }
    if (key.startsWith('/')) {
      throw new ValidationError('object key must not start with a slash', { key });
    }
  }
}

function isNotFoundError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
}
