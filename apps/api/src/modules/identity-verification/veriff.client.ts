/**
 * Veriff identity-verification integration — the driver app's handoff
 * scan provider per spec §6.2 and Phase 20 §20.3.
 *
 * Three surfaces:
 *
 *   createSession({ orderId, callbackUrl, person }) →
 *     POSTs to `${apiBaseUrl}/v1/sessions` with the order id stashed in
 *     `vendorData`. The HMAC-SHA256 signature of the raw JSON body is
 *     sent in `X-HMAC-SIGNATURE`; the public API key is sent in
 *     `X-AUTH-CLIENT`. Returns the `(verificationId, sessionUrl,
 *     sessionToken)` triple. iOS hands the token to the Veriff SDK.
 *
 *   getDecision(verificationId) →
 *     GETs `${apiBaseUrl}/v1/sessions/:id/decision` and returns a typed
 *     decision envelope: approved | declined | resubmission | expired |
 *     pending. Called from the driver app's submit-result endpoint to
 *     read the authoritative status (the SDK callback alone is not a
 *     trustworthy source — the driver could lie about a fail).
 *
 *   handleWebhook(rawBody, signatureHeader) →
 *     Verifies the HMAC-SHA256 signature of the raw body against the
 *     webhook secret (constant-time compare; the multi-value `v1=` form
 *     is unused — Veriff sends a single hex digest). Parses the JSON
 *     payload through Zod and returns the same decision envelope as
 *     getDecision so callers route both push and pull paths through one
 *     write surface.
 *
 * No DB writes here. The orchestrating service (DriverIdScanService)
 * consumes the returned values and performs the idempotent
 * age_verifications insert + orders patch + status transition inside a
 * transaction. Keeps VeriffClient unit-testable without a database, and
 * keeps the webhook controller a thin HMAC gate.
 *
 * Sandbox vs production: the constructor takes an `apiBaseUrl` override
 * so `.env` switches between `https://stationapi.veriff.com` (default,
 * shared by sandbox + production — Veriff routes by API key) and any
 * test double. The sandbox API key + secret accept any submitted
 * document and return deterministic `approved` decisions, so CI never
 * reaches a real Veriff endpoint.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { KycError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

export interface VeriffClientConfig {
  /** Veriff public API key — sent in `X-AUTH-CLIENT`. */
  readonly apiKey: string;
  /**
   * Veriff secret — used to HMAC-SHA256 sign outbound request bodies and
   * to verify webhook signatures. Veriff treats this as a single shared
   * secret; we mirror that here rather than pretending to two surfaces.
   */
  readonly secret: string;
  /** Override for staging / sandbox / tests. */
  readonly apiBaseUrl?: string;
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Injected for tests; defaults to `() => new Date()`. */
  readonly clock?: () => Date;
}

export interface CreateVeriffSessionInput {
  /** Stashed in `vendorData` so the webhook ties back to the order row. */
  readonly orderId: string;
  /**
   * Where Veriff redirects the user when the session completes — used by
   * the hosted-flow fallback (not the SDK path). The SDK ignores this
   * but Veriff requires the field, so we always populate it.
   */
  readonly callback: string;
  /**
   * Optional human identity hints. Veriff cross-references these against
   * the scanned document for additional confidence; omitting them lets
   * the OCR drive the comparison.
   */
  readonly person?: VeriffPerson;
  readonly document?: VeriffDocument;
}

export interface VeriffPerson {
  readonly firstName?: string;
  readonly lastName?: string;
}

export interface VeriffDocument {
  readonly type?: 'PASSPORT' | 'ID_CARD' | 'RESIDENCE_PERMIT' | 'DRIVERS_LICENSE';
  readonly country?: string;
}

export interface VeriffSession {
  readonly verificationId: string;
  readonly sessionUrl: string;
  readonly sessionToken: string;
}

/**
 * Verdict envelope returned by both `getDecision` (pull) and
 * `handleWebhook` (push). The two paths converge on this shape so the
 * caller has a single write routine that idempotently records the
 * outcome regardless of how it arrived.
 *
 * `pending` is only emitted by `getDecision` — webhooks fire on terminal
 * decisions only. The submit-result endpoint sees `pending` when the
 * driver taps Submit before Veriff has rendered a decision; the iOS
 * client then polls until the state moves.
 */
export type VeriffDecision =
  | {
      readonly type: 'approved';
      readonly verificationId: string;
      readonly orderId: string | null;
      readonly decisionAt: string;
      readonly code: number | null;
    }
  | {
      readonly type: 'declined';
      readonly verificationId: string;
      readonly orderId: string | null;
      readonly decisionAt: string;
      readonly reason: string | null;
      readonly code: number | null;
    }
  | {
      readonly type: 'resubmission';
      readonly verificationId: string;
      readonly orderId: string | null;
      readonly decisionAt: string;
      readonly reason: string | null;
      readonly code: number | null;
    }
  | {
      readonly type: 'expired';
      readonly verificationId: string;
      readonly orderId: string | null;
      readonly decisionAt: string;
      readonly code: number | null;
    }
  | { readonly type: 'pending'; readonly verificationId: string };

const DEFAULT_API_BASE_URL = 'https://stationapi.veriff.com';

const AUTH_HEADER = 'X-AUTH-CLIENT';
const SIGNATURE_HEADER = 'X-HMAC-SIGNATURE';

const SessionResponseSchema = z.object({
  status: z.string().optional(),
  verification: z.object({
    id: z.string().min(1),
    url: z.string().url(),
    sessionToken: z.string().min(1),
  }),
});

/**
 * Webhook payload. Veriff's status field carries the terminal verdict
 * (`approved`, `declined`, `resubmission_requested`, `expired`,
 * `abandoned`). `code` is the numeric variant — 9001 approved, 9102
 * declined, etc. — useful for grouping decline reasons in dashboards.
 *
 * The `vendorData` round-trips whatever we stashed at session creation
 * — for us, the order UUID — so the receiver can look up the row
 * without scanning by verification id.
 */
const DecisionPayloadSchema = z.object({
  status: z.string().optional(),
  verification: z
    .object({
      id: z.string().min(1),
      code: z.number().int().optional(),
      status: z.string().min(1),
      vendorData: z.union([z.string(), z.null()]).optional(),
      reason: z.union([z.string(), z.null()]).optional(),
      reasonCode: z.union([z.number(), z.string(), z.null()]).optional(),
      decisionTime: z.union([z.string(), z.null()]).optional(),
      acceptanceTime: z.union([z.string(), z.null()]).optional(),
    })
    .passthrough(),
});

@Injectable()
export class VeriffClient {
  private readonly apiKey: string;
  private readonly secret: string;
  private readonly apiBaseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly clock: () => Date;

  constructor(config: VeriffClientConfig) {
    this.apiKey = config.apiKey;
    this.secret = config.secret;
    this.apiBaseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    this.fetch = config.fetch ?? fetch;
    this.clock = config.clock ?? ((): Date => new Date());
  }

  async createSession(input: CreateVeriffSessionInput): Promise<VeriffSession> {
    const body = JSON.stringify({
      verification: {
        callback: input.callback,
        person: input.person ?? {},
        document: input.document ?? {},
        vendorData: input.orderId,
        timestamp: this.clock().toISOString(),
      },
    });

    const url = `${this.apiBaseUrl}/v1/sessions`;
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          [AUTH_HEADER]: this.apiKey,
          [SIGNATURE_HEADER]: this.sign(body),
        },
        body,
      });
    } catch (err) {
      throw new KycError(
        'KYC_INQUIRY_FAILED',
        'Veriff session request failed',
        { orderId: input.orderId },
        err,
      );
    }

    if (!response.ok) {
      const bodyText = await response.text().catch((): string => '');
      throw new KycError(
        'KYC_INQUIRY_FAILED',
        `Veriff session creation returned ${String(response.status)}`,
        {
          orderId: input.orderId,
          status: response.status,
          body: bodyText.slice(0, 512),
        },
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (err) {
      throw new KycError(
        'KYC_INQUIRY_FAILED',
        'Veriff response was not valid JSON',
        { orderId: input.orderId },
        err,
      );
    }

    const validated = SessionResponseSchema.safeParse(parsed);
    if (!validated.success) {
      throw new KycError('KYC_INQUIRY_FAILED', 'Veriff response missing verification fields', {
        orderId: input.orderId,
        issues: validated.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    return {
      verificationId: validated.data.verification.id,
      sessionUrl: validated.data.verification.url,
      sessionToken: validated.data.verification.sessionToken,
    };
  }

  async getDecision(verificationId: string): Promise<VeriffDecision> {
    const url = `${this.apiBaseUrl}/v1/sessions/${encodeURIComponent(verificationId)}/decision`;
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          [AUTH_HEADER]: this.apiKey,
          // GET requests have no body — Veriff requires the HMAC of the
          // session id itself in the signature header.
          [SIGNATURE_HEADER]: this.sign(verificationId),
        },
      });
    } catch (err) {
      throw new KycError(
        'KYC_INQUIRY_FAILED',
        'Veriff decision request failed',
        { verificationId },
        err,
      );
    }

    if (response.status === 404) {
      // Decision not yet rendered. iOS polls a few times before giving up.
      return { type: 'pending', verificationId };
    }

    if (!response.ok) {
      const bodyText = await response.text().catch((): string => '');
      throw new KycError(
        'KYC_INQUIRY_FAILED',
        `Veriff decision lookup returned ${String(response.status)}`,
        {
          verificationId,
          status: response.status,
          body: bodyText.slice(0, 512),
        },
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (err) {
      throw new KycError(
        'KYC_INQUIRY_FAILED',
        'Veriff decision response was not valid JSON',
        { verificationId },
        err,
      );
    }

    return this.parseDecisionPayload(parsed, verificationId);
  }

  /**
   * Verifies the HMAC and parses the webhook body. Raises KycError
   * variants — `KYC_WEBHOOK_SIGNATURE_INVALID` on signature failure,
   * `KYC_WEBHOOK_PAYLOAD_INVALID` on shape failure — which the global
   * filter renders as 401 / 400 and which Veriff treats as
   * non-retriable (we want immediate-fail rather than a 24h retry
   * storm on a malformed delivery).
   */
  handleWebhook(rawBody: string, signatureHeader: string): VeriffDecision {
    this.verifyWebhookSignature(rawBody, signatureHeader);

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch (err) {
      throw new KycError(
        'KYC_WEBHOOK_PAYLOAD_INVALID',
        'Veriff webhook body is not valid JSON',
        {},
        err,
      );
    }

    return this.parseDecisionPayload(json, null);
  }

  private parseDecisionPayload(
    payload: unknown,
    expectedVerificationId: string | null,
  ): VeriffDecision {
    const validated = DecisionPayloadSchema.safeParse(payload);
    if (!validated.success) {
      throw new KycError(
        'KYC_WEBHOOK_PAYLOAD_INVALID',
        'Veriff decision payload failed schema validation',
        {
          issues: validated.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      );
    }

    const v = validated.data.verification;
    if (expectedVerificationId !== null && v.id !== expectedVerificationId) {
      // GET /sessions/:id/decision returned a different verification id
      // than the one we asked about — should never happen, but a
      // mismatch suggests upstream confusion (cached response?) and we
      // refuse to write under a possibly wrong order id.
      throw new KycError('KYC_WEBHOOK_PAYLOAD_INVALID', 'Veriff verification id mismatch', {
        expected: expectedVerificationId,
        received: v.id,
      });
    }

    const orderId =
      typeof v.vendorData === 'string' && v.vendorData.length > 0 ? v.vendorData : null;
    const decisionAt =
      typeof v.decisionTime === 'string' && v.decisionTime.length > 0
        ? v.decisionTime
        : typeof v.acceptanceTime === 'string' && v.acceptanceTime.length > 0
          ? v.acceptanceTime
          : this.clock().toISOString();
    const code = typeof v.code === 'number' ? v.code : null;
    const reason = typeof v.reason === 'string' && v.reason.length > 0 ? v.reason : null;

    switch (v.status) {
      case 'approved':
      case 'success':
        return { type: 'approved', verificationId: v.id, orderId, decisionAt, code };
      case 'declined':
        return { type: 'declined', verificationId: v.id, orderId, decisionAt, reason, code };
      case 'resubmission_requested':
      case 'resubmission':
        return { type: 'resubmission', verificationId: v.id, orderId, decisionAt, reason, code };
      case 'expired':
      case 'abandoned':
        return { type: 'expired', verificationId: v.id, orderId, decisionAt, code };
      default:
        return { type: 'pending', verificationId: v.id };
    }
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('hex');
  }

  private verifyWebhookSignature(rawBody: string, signatureHeader: string): void {
    if (signatureHeader.length === 0) {
      throw new KycError(
        'KYC_WEBHOOK_SIGNATURE_INVALID',
        'Veriff webhook signature header is empty',
        {},
      );
    }

    const expected = createHmac('sha256', this.secret).update(rawBody).digest();

    let candidate: Buffer;
    try {
      candidate = Buffer.from(signatureHeader.trim(), 'hex');
    } catch {
      throw new KycError(
        'KYC_WEBHOOK_SIGNATURE_INVALID',
        'Veriff webhook signature is not valid hex',
        {},
      );
    }

    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      throw new KycError(
        'KYC_WEBHOOK_SIGNATURE_INVALID',
        'Veriff webhook signature verification failed',
        {},
      );
    }
  }
}
