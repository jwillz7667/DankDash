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
  readonly fields: Readonly<Record<string, string>>;
  readonly objectKey: string;
  readonly expiresAt: string;
}

/**
 * Raised when the direct-to-R2 multipart POST fails. The presign request
 * itself surfaces as {@link import('./client.js').ApiError}; this is
 * specifically the storage leg, which never touches the API and so carries
 * no error envelope.
 */
export class ImageUploadError extends Error {
  public readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'ImageUploadError';
    this.status = status;
  }
}

/**
 * Uploads a file straight to R2 using a presigned POST {@link ticket}.
 *
 * Runs in the browser (the file is a `File`/`Blob`), bypassing the API so
 * large image bytes never traverse the Node event loop. The policy fields
 * must be appended in order with the file LAST — S3/R2 ignore form fields
 * that appear after the `file` part, and `Content-Type` must precede it for
 * the policy condition to match. Returns the object key to persist.
 *
 * `fetchImpl` is injectable for tests; production uses the global `fetch`.
 */
export async function uploadImageToStorage(
  ticket: ImageUploadTicket,
  file: Blob,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<string> {
  const form = new FormData();
  for (const [key, value] of Object.entries(ticket.fields)) {
    form.append(key, value);
  }
  form.append('file', file);

  let response: Response;
  try {
    response = await fetchImpl(ticket.uploadUrl, { method: 'POST', body: form });
  } catch (cause) {
    throw new ImageUploadError(
      cause instanceof Error ? cause.message : 'network error during image upload',
      null,
    );
  }
  if (!response.ok) {
    throw new ImageUploadError('image upload rejected by storage', response.status);
  }
  return ticket.objectKey;
}
