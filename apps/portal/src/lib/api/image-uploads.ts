/**
 * Shared client primitives for the presigned-upload → direct-to-R2 flow.
 *
 * Both the listing-image uploader (`vendor-listings.ts`) and the brand-image
 * uploader (`vendor-settings.ts`) speak the same presign contract: the API
 * mints a presigned POST policy, the browser submits it straight to R2 with
 * the file bytes (never traversing the portal's Node runtime), and the
 * returned object key is then persisted via a PATCH. These primitives are
 * factored here so the two surfaces share one implementation rather than
 * drifting two copies.
 *
 * The accepted content types mirror `UPLOADABLE_IMAGE_CONTENT_TYPES` in
 * `apps/api/src/modules/listings/vendor/dto/image-upload.dto.ts`. SVG is
 * excluded on purpose (XSS vector when served from a content domain).
 */
export const UPLOADABLE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type UploadableImageType = (typeof UPLOADABLE_IMAGE_TYPES)[number];

export function isUploadableImageType(value: string): value is UploadableImageType {
  return (UPLOADABLE_IMAGE_TYPES as readonly string[]).includes(value);
}

/**
 * Presigned POST policy returned by an `image-uploads` endpoint. The browser
 * submits `fields` verbatim as multipart/form-data with the file appended
 * last under a `file` field; `objectKey` is the key to persist once the
 * upload succeeds.
 */
export interface ImageUploadTicket {
  readonly uploadUrl: string;
  /** Always `PUT` — R2 does not support presigned POST. */
  readonly method: 'PUT';
  /** Headers that must be sent verbatim on the PUT (at minimum `Content-Type`). */
  readonly headers: Readonly<Record<string, string>>;
  readonly objectKey: string;
  readonly expiresAt: string;
}

/**
 * Raised when the direct-to-R2 upload fails. The presign request itself
 * surfaces as {@link import('./client.js').ApiError}; this is specifically the
 * storage leg, which never touches the API and so carries no error envelope.
 */
export class ImageUploadError extends Error {
  public readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'ImageUploadError';
    this.status = status;
  }
}

/** Max attempts (1 initial + 2 retries) for transient storage failures. */
const MAX_UPLOAD_ATTEMPTS = 3;
/** Base backoff between retries; grows linearly per attempt. */
const RETRY_BASE_DELAY_MS = 400;

function isTransientStatus(status: number): boolean {
  // 5xx and 429 are worth retrying; 408 (request timeout) too. A 4xx
  // signature/policy error (403/400) is deterministic — retrying is pointless.
  return status >= 500 || status === 429 || status === 408;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Uploads a file straight to R2 using a presigned PUT {@link ticket}.
 *
 * Runs in the browser (the file is a `File`/`Blob`), bypassing the API so
 * large image bytes never traverse the Node event loop. R2 does not implement
 * S3 presigned POST (returns 501 NotImplemented), so this issues a single
 * `PUT` with the raw file as the body and the signed headers verbatim — the
 * `Content-Type` header is part of the signature and must match exactly.
 *
 * Hardened against flaky networks: transient failures (network drop, 5xx, 429,
 * 408) are retried up to {@link MAX_UPLOAD_ATTEMPTS} times with linear backoff.
 * Deterministic 4xx responses (bad/expired signature) fail fast — a retry would
 * only repeat the same rejection. Returns the object key to persist.
 *
 * `fetchImpl` is injectable for tests; production uses the global `fetch`.
 */
export async function uploadImageToStorage(
  ticket: ImageUploadTicket,
  file: Blob,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<string> {
  let lastError: ImageUploadError | null = null;

  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(ticket.uploadUrl, {
        method: 'PUT',
        headers: { ...ticket.headers },
        body: file,
      });
    } catch (cause) {
      // Network-level failure (DNS, TLS, connection reset) — always transient.
      lastError = new ImageUploadError(
        cause instanceof Error ? cause.message : 'network error during image upload',
        null,
      );
      if (attempt < MAX_UPLOAD_ATTEMPTS) {
        await sleep(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      throw lastError;
    }

    if (response.ok) {
      return ticket.objectKey;
    }

    lastError = new ImageUploadError(
      `image upload rejected by storage (HTTP ${response.status})`,
      response.status,
    );
    if (isTransientStatus(response.status) && attempt < MAX_UPLOAD_ATTEMPTS) {
      await sleep(RETRY_BASE_DELAY_MS * attempt);
      continue;
    }
    throw lastError;
  }

  // Unreachable in practice — the loop either returns or throws — but keeps
  // the return type honest for the type checker.
  throw lastError ?? new ImageUploadError('image upload failed', null);
}
