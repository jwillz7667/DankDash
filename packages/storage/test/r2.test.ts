import { DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ConfigError, ExternalServiceError, ValidationError } from '@dankdash/types';
import { mockClient, type AwsClientStub } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { R2Storage, type R2Config } from '../src/r2.js';

// Spy on the local presigner modules so individual tests can inject a
// one-shot rejection to exercise the catch blocks in `presignUpload` and
// `presignDownload`. `spy: true` preserves the real implementation, so
// every other test calls through to the genuine signer.
vi.mock('@aws-sdk/s3-presigned-post', { spy: true });
vi.mock('@aws-sdk/s3-request-presigner', { spy: true });

const baseConfig: R2Config = {
  accountId: '11112222333344445555666677778888',
  accessKeyId: 'AKIA-TEST-ACCESS-KEY',
  secretAccessKey: 'TEST/secret+access/KEY',
  bucket: 'dankdash-test',
};

const baseConfigWithPublic: R2Config = {
  ...baseConfig,
  publicBaseUrl: 'https://cdn.dankdash.example',
};

const R2_HOST = '11112222333344445555666677778888.r2.cloudflarestorage.com';

describe('R2Storage', () => {
  let s3Mock: AwsClientStub<S3Client>;

  beforeEach(() => {
    s3Mock = mockClient(S3Client);
  });

  afterEach(() => {
    s3Mock.restore();
  });

  describe('presignUpload', () => {
    it('returns a presigned POST against the bucket endpoint with default 5-minute TTL', async () => {
      const storage = new R2Storage(baseConfig);
      const before = Date.now();
      const presigned = await storage.presignUpload({
        key: 'uploads/abc.jpg',
        contentType: 'image/jpeg',
        contentLengthMax: 5 * 1024 * 1024,
      });

      expect(presigned.url).toMatch(/^https:\/\//);
      expect(presigned.url).toContain(R2_HOST);
      expect(presigned.url).toContain('dankdash-test');

      expect(presigned.fields).toMatchObject({
        key: 'uploads/abc.jpg',
        'Content-Type': 'image/jpeg',
      });
      expect(presigned.fields).toHaveProperty('Policy');
      expect(presigned.fields).toHaveProperty('X-Amz-Algorithm');
      expect(presigned.fields).toHaveProperty('X-Amz-Credential');
      expect(presigned.fields).toHaveProperty('X-Amz-Date');
      expect(presigned.fields).toHaveProperty('X-Amz-Signature');

      const ttlMs = presigned.expiresAt.getTime() - before;
      expect(ttlMs).toBeGreaterThan(290_000);
      expect(ttlMs).toBeLessThan(310_000);
    });

    it('honors a custom expiresInSec', async () => {
      const storage = new R2Storage(baseConfig);
      const before = Date.now();
      const presigned = await storage.presignUpload({
        key: 'uploads/big.bin',
        contentType: 'application/octet-stream',
        contentLengthMax: 100 * 1024 * 1024,
        expiresInSec: 60,
      });
      const ttlMs = presigned.expiresAt.getTime() - before;
      expect(ttlMs).toBeGreaterThan(50_000);
      expect(ttlMs).toBeLessThan(70_000);
    });

    it('encodes a content-length-range condition in the policy', async () => {
      const storage = new R2Storage(baseConfig);
      const presigned = await storage.presignUpload({
        key: 'uploads/policy.txt',
        contentType: 'text/plain',
        contentLengthMax: 1234,
      });
      const policyB64 = presigned.fields['Policy'];
      expect(policyB64).toBeTypeOf('string');
      const policy = JSON.parse(Buffer.from(policyB64!, 'base64').toString('utf8')) as {
        conditions: unknown[];
      };
      const hasRange = policy.conditions.some(
        (c) => Array.isArray(c) && c[0] === 'content-length-range' && c[1] === 1 && c[2] === 1234,
      );
      expect(hasRange).toBe(true);
    });

    it('rejects an empty key with ValidationError', async () => {
      const storage = new R2Storage(baseConfig);
      await expect(
        storage.presignUpload({ key: '', contentType: 'image/jpeg', contentLengthMax: 1 }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects a key with a leading slash', async () => {
      const storage = new R2Storage(baseConfig);
      await expect(
        storage.presignUpload({
          key: '/uploads/abc.jpg',
          contentType: 'image/jpeg',
          contentLengthMax: 1,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects non-positive contentLengthMax', async () => {
      const storage = new R2Storage(baseConfig);
      await expect(
        storage.presignUpload({
          key: 'uploads/abc.jpg',
          contentType: 'image/jpeg',
          contentLengthMax: 0,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        storage.presignUpload({
          key: 'uploads/abc.jpg',
          contentType: 'image/jpeg',
          contentLengthMax: -1,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('wraps presigner failures in ExternalServiceError', async () => {
      vi.mocked(createPresignedPost).mockRejectedValueOnce(new Error('signer boom'));
      const storage = new R2Storage(baseConfig);
      try {
        await storage.presignUpload({
          key: 'uploads/abc.jpg',
          contentType: 'image/jpeg',
          contentLengthMax: 1024,
        });
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ExternalServiceError);
        expect((err as ExternalServiceError).details).toMatchObject({
          service: 'cloudflare-r2',
          key: 'uploads/abc.jpg',
        });
      }
    });
  });

  describe('presignDownload', () => {
    it('returns a signed GET URL with the configured TTL', async () => {
      const storage = new R2Storage(baseConfig);
      const url = await storage.presignDownload('coas/abc.pdf');
      expect(url).toContain(R2_HOST);
      expect(url).toContain('dankdash-test');
      expect(url).toContain('coas/abc.pdf');
      expect(url).toContain('X-Amz-Signature=');
      expect(url).toContain('X-Amz-Expires=300');
    });

    it('honors a custom expiresInSec', async () => {
      const storage = new R2Storage(baseConfig);
      const url = await storage.presignDownload('coas/abc.pdf', 1800);
      expect(url).toContain('X-Amz-Expires=1800');
    });

    it('rejects an empty key with ValidationError', async () => {
      const storage = new R2Storage(baseConfig);
      await expect(storage.presignDownload('')).rejects.toBeInstanceOf(ValidationError);
    });

    it('wraps presigner failures in ExternalServiceError', async () => {
      vi.mocked(getSignedUrl).mockRejectedValueOnce(new Error('signer boom'));
      const storage = new R2Storage(baseConfig);
      try {
        await storage.presignDownload('coas/abc.pdf');
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ExternalServiceError);
        expect((err as ExternalServiceError).details).toMatchObject({
          service: 'cloudflare-r2',
          key: 'coas/abc.pdf',
        });
      }
    });
  });

  describe('getPublicUrl', () => {
    it('concatenates publicBaseUrl and key with a single slash', () => {
      const storage = new R2Storage(baseConfigWithPublic);
      expect(storage.getPublicUrl('products/abc.jpg')).toBe(
        'https://cdn.dankdash.example/products/abc.jpg',
      );
    });

    it('strips a trailing slash from publicBaseUrl', () => {
      const storage = new R2Storage({
        ...baseConfig,
        publicBaseUrl: 'https://cdn.dankdash.example/',
      });
      expect(storage.getPublicUrl('products/abc.jpg')).toBe(
        'https://cdn.dankdash.example/products/abc.jpg',
      );
    });

    it('throws ConfigError(CONFIG_MISSING) when publicBaseUrl is not configured', () => {
      const storage = new R2Storage(baseConfig);
      try {
        storage.getPublicUrl('products/abc.jpg');
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe('CONFIG_MISSING');
        expect((err as ConfigError).details).toMatchObject({ bucket: 'dankdash-test' });
      }
    });

    it('rejects an empty key with ValidationError', () => {
      const storage = new R2Storage(baseConfigWithPublic);
      expect(() => storage.getPublicUrl('')).toThrow(ValidationError);
    });
  });

  describe('deleteObject', () => {
    it('issues a DeleteObjectCommand with bucket and key', async () => {
      s3Mock.on(DeleteObjectCommand).resolves({});
      const storage = new R2Storage(baseConfig);
      await storage.deleteObject('uploads/abc.jpg');
      const calls = s3Mock.commandCalls(DeleteObjectCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0].input).toEqual({
        Bucket: 'dankdash-test',
        Key: 'uploads/abc.jpg',
      });
    });

    it('wraps upstream errors in ExternalServiceError tagged with the service', async () => {
      s3Mock.on(DeleteObjectCommand).rejects(new Error('network down'));
      const storage = new R2Storage(baseConfig);
      try {
        await storage.deleteObject('uploads/abc.jpg');
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ExternalServiceError);
        expect((err as ExternalServiceError).details).toMatchObject({
          service: 'cloudflare-r2',
          key: 'uploads/abc.jpg',
        });
      }
    });

    it('rejects an empty key with ValidationError', async () => {
      const storage = new R2Storage(baseConfig);
      await expect(storage.deleteObject('')).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('objectExists', () => {
    it('returns true when HeadObject succeeds', async () => {
      s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 1234 });
      const storage = new R2Storage(baseConfig);
      await expect(storage.objectExists('uploads/abc.jpg')).resolves.toBe(true);
    });

    it('returns false when the SDK throws an exception named NotFound', async () => {
      const notFound = Object.assign(new Error('not found'), {
        name: 'NotFound',
        $metadata: {},
      });
      s3Mock.on(HeadObjectCommand).rejects(notFound);
      const storage = new R2Storage(baseConfig);
      await expect(storage.objectExists('uploads/missing.jpg')).resolves.toBe(false);
    });

    it('returns false when the SDK throws with a 404 in $metadata', async () => {
      const fourOhFour = Object.assign(new Error('Not Found'), {
        name: 'S3ServiceException',
        $metadata: { httpStatusCode: 404 },
      });
      s3Mock.on(HeadObjectCommand).rejects(fourOhFour);
      const storage = new R2Storage(baseConfig);
      await expect(storage.objectExists('uploads/missing.jpg')).resolves.toBe(false);
    });

    it('wraps other errors in ExternalServiceError', async () => {
      s3Mock.on(HeadObjectCommand).rejects(new Error('timeout'));
      const storage = new R2Storage(baseConfig);
      try {
        await storage.objectExists('uploads/abc.jpg');
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ExternalServiceError);
        expect((err as ExternalServiceError).details).toMatchObject({
          service: 'cloudflare-r2',
          key: 'uploads/abc.jpg',
        });
      }
    });

    it('rejects an empty key with ValidationError', async () => {
      const storage = new R2Storage(baseConfig);
      await expect(storage.objectExists('')).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
