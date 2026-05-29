/**
 * Persona KYC integration.
 *
 * Two surfaces:
 *
 *   createInquiry(userId) →
 *     POSTs to Persona /api/v1/inquiries with `inquiry-template-id` and
 *     `reference-id = userId`. Returns the inquiry id (callers persist as
 *     users.kyc_provider_ref) and the hosted-flow URL the iOS client opens
 *     via SFSafariViewController.
 *
 *   handleWebhook(rawBody, signatureHeader) →
 *     1. Parse `Persona-Signature` header (`t=ts,v1=sig[,v1=sig...]`).
 *     2. HMAC-SHA256(secret, `${ts}.${rawBody}`) must constant-time-match at
 *        least one `v1=` value (the multi-value form supports webhook-secret
 *        rotation without dropped events).
 *     3. Reject timestamps outside the tolerance window (default ±300s) as
 *        replay protection.
 *     4. Parse the JSON:API event envelope through a Zod schema — anything
 *        malformed raises KYC_WEBHOOK_PAYLOAD_INVALID rather than crashing on
 *        ad-hoc property access.
 *     5. Dispatch:
 *        - inquiry.completed → verify DOB present + age ≥ 21 (Minn. Stat. §
 *          342.46) → WebhookOutcome.kyc.completed
 *        - inquiry.failed    → WebhookOutcome.kyc.failed
 *        - inquiry.expired   → WebhookOutcome.kyc.expired
 *        - anything else     → WebhookOutcome.ignored
 *
 * The service is intentionally pure I/O + verification: no DB writes here.
 * The controller layer (Phase 2.7) consumes the outcome and performs the
 * users.kyc_verified_at / status transition / audit-row writes inside a
 * single transaction. Keeps PersonaService unit-testable without a database.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { KycError } from '@dankdash/types';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

/**
 * MN adult-use cannabis sale minimum age (Minn. Stat. § 342.46). Lives here
 * because Phase 2 ships ahead of `@dankdash/compliance/constants` — when the
 * compliance package is fleshed out (Phase 3), this constant moves there and
 * PersonaService imports it from the canonical source.
 */
export const MIN_AGE_YEARS = 21;

export interface PersonaServiceConfig {
  readonly apiKey: string;
  readonly templateId: string;
  readonly webhookSecret: string;
  readonly apiBaseUrl?: string;
  readonly hostedFlowBaseUrl?: string;
  readonly webhookToleranceSeconds?: number;
  readonly fetch?: typeof fetch;
  readonly clock?: () => Date;
}

export interface PersonaInquiry {
  readonly inquiryId: string;
  readonly hostedFlowUrl: string;
}

export type WebhookOutcome =
  | {
      readonly type: 'kyc.completed';
      readonly eventId: string;
      readonly userId: string;
      readonly inquiryId: string;
      readonly dateOfBirth: string;
    }
  | {
      readonly type: 'kyc.failed';
      readonly eventId: string;
      readonly userId: string;
      readonly inquiryId: string;
    }
  | {
      readonly type: 'kyc.expired';
      readonly eventId: string;
      readonly userId: string;
      readonly inquiryId: string;
    }
  | { readonly type: 'ignored'; readonly eventId: string; readonly eventName: string };

const DEFAULT_API_BASE_URL = 'https://withpersona.com';
const DEFAULT_HOSTED_FLOW_BASE_URL = 'https://withpersona.com/verify';
const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;
const PERSONA_API_VERSION = '2023-01-05';

const InquiryFieldSchema = z
  .object({
    value: z.union([z.string(), z.null()]).optional(),
  })
  .passthrough();

const InquiryPayloadSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    attributes: z
      .object({
        'reference-id': z.union([z.string(), z.null()]).optional(),
        fields: z.record(z.string(), InquiryFieldSchema).optional(),
      })
      .passthrough(),
  }),
});

const WebhookEnvelopeSchema = z.object({
  data: z.object({
    // Persona's top-level event id (e.g. `evt_...`). This is the dedup key:
    // Persona retries the same event for up to 24h, always reusing this id.
    id: z.string().min(1),
    attributes: z.object({
      name: z.string().min(1),
      payload: InquiryPayloadSchema,
    }),
  }),
});

@Injectable()
export class PersonaService {
  private readonly apiKey: string;
  private readonly templateId: string;
  private readonly webhookSecret: string;
  private readonly apiBaseUrl: string;
  private readonly hostedFlowBaseUrl: string;
  private readonly webhookToleranceSeconds: number;
  private readonly fetch: typeof fetch;
  private readonly clock: () => Date;

  constructor(config: PersonaServiceConfig) {
    this.apiKey = config.apiKey;
    this.templateId = config.templateId;
    this.webhookSecret = config.webhookSecret;
    this.apiBaseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    this.hostedFlowBaseUrl = config.hostedFlowBaseUrl ?? DEFAULT_HOSTED_FLOW_BASE_URL;
    this.webhookToleranceSeconds =
      config.webhookToleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
    this.fetch = config.fetch ?? fetch;
    this.clock = config.clock ?? ((): Date => new Date());
  }

  async createInquiry(userId: string): Promise<PersonaInquiry> {
    const url = `${this.apiBaseUrl}/api/v1/inquiries`;
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Persona-Version': PERSONA_API_VERSION,
        },
        body: JSON.stringify({
          data: {
            attributes: {
              'inquiry-template-id': this.templateId,
              'reference-id': userId,
            },
          },
        }),
      });
    } catch (err) {
      throw new KycError('KYC_INQUIRY_FAILED', 'Persona inquiry request failed', { userId }, err);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch((): string => '');
      throw new KycError(
        'KYC_INQUIRY_FAILED',
        `Persona inquiry creation returned ${response.status}`,
        {
          userId,
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
        'Persona response was not valid JSON',
        { userId },
        err,
      );
    }

    const inquiryId = extractInquiryId(parsed);
    if (inquiryId === null) {
      throw new KycError('KYC_INQUIRY_FAILED', 'Persona response missing data.id', { userId });
    }

    const hostedFlowUrl =
      `${this.hostedFlowBaseUrl}?inquiry-id=${encodeURIComponent(inquiryId)}` +
      `&reference-id=${encodeURIComponent(userId)}`;
    return { inquiryId, hostedFlowUrl };
  }

  handleWebhook(rawBody: string, signatureHeader: string): WebhookOutcome {
    this.verifySignature(rawBody, signatureHeader);

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch (err) {
      throw new KycError('KYC_WEBHOOK_PAYLOAD_INVALID', 'webhook body is not valid JSON', {}, err);
    }

    const parsed = WebhookEnvelopeSchema.safeParse(json);
    if (!parsed.success) {
      throw new KycError(
        'KYC_WEBHOOK_PAYLOAD_INVALID',
        'webhook envelope failed schema validation',
        {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      );
    }

    const eventId = parsed.data.data.id;
    const eventName = parsed.data.data.attributes.name;
    const inquiry = parsed.data.data.attributes.payload.data;
    const inquiryId = inquiry.id;
    const referenceId = inquiry.attributes['reference-id'] ?? null;

    switch (eventName) {
      case 'inquiry.completed':
      case 'inquiry.approved': {
        if (referenceId === null || referenceId.length === 0) {
          throw new KycError(
            'KYC_WEBHOOK_PAYLOAD_INVALID',
            'completed inquiry missing reference-id',
            {
              inquiryId,
            },
          );
        }
        const dob = extractDateOfBirth(inquiry.attributes.fields);
        if (dob === null) {
          throw new KycError('KYC_DOB_MISSING', 'completed inquiry missing birthdate field', {
            inquiryId,
            referenceId,
          });
        }
        const age = calculateAge(dob, this.clock());
        if (age < MIN_AGE_YEARS) {
          throw new KycError(
            'KYC_AGE_UNDER_MINIMUM',
            `applicant age ${String(age)} below minimum ${String(MIN_AGE_YEARS)}`,
            { age, minimum: MIN_AGE_YEARS, inquiryId, referenceId },
          );
        }
        return {
          type: 'kyc.completed',
          eventId,
          userId: referenceId,
          inquiryId,
          dateOfBirth: dob,
        };
      }
      case 'inquiry.failed':
      case 'inquiry.declined': {
        if (referenceId === null || referenceId.length === 0) {
          throw new KycError('KYC_WEBHOOK_PAYLOAD_INVALID', 'failed inquiry missing reference-id', {
            inquiryId,
          });
        }
        return { type: 'kyc.failed', eventId, userId: referenceId, inquiryId };
      }
      case 'inquiry.expired': {
        if (referenceId === null || referenceId.length === 0) {
          throw new KycError(
            'KYC_WEBHOOK_PAYLOAD_INVALID',
            'expired inquiry missing reference-id',
            {
              inquiryId,
            },
          );
        }
        return { type: 'kyc.expired', eventId, userId: referenceId, inquiryId };
      }
      default:
        return { type: 'ignored', eventId, eventName };
    }
  }

  private verifySignature(rawBody: string, signatureHeader: string): void {
    const { timestamp, signatures } = parseSignatureHeader(signatureHeader);
    if (timestamp === null || signatures.length === 0) {
      throw new KycError(
        'KYC_WEBHOOK_SIGNATURE_INVALID',
        'webhook signature header missing t= or v1=',
        {},
      );
    }

    const nowSeconds = Math.floor(this.clock().getTime() / 1000);
    if (Math.abs(nowSeconds - timestamp) > this.webhookToleranceSeconds) {
      throw new KycError('KYC_WEBHOOK_TIMESTAMP_STALE', 'webhook timestamp outside tolerance', {
        received: timestamp,
        now: nowSeconds,
        toleranceSeconds: this.webhookToleranceSeconds,
      });
    }

    const expected = createHmac('sha256', this.webhookSecret)
      .update(`${String(timestamp)}.${rawBody}`)
      .digest();

    const matched = signatures.some((candidateHex) => {
      // Per-candidate try: a malformed hex string or wrong-length sig should
      // not abort the whole comparison — it just isn't a match.
      let candidate: Buffer;
      try {
        candidate = Buffer.from(candidateHex, 'hex');
      } catch {
        return false;
      }
      if (candidate.length !== expected.length) return false;
      return timingSafeEqual(candidate, expected);
    });

    if (!matched) {
      throw new KycError(
        'KYC_WEBHOOK_SIGNATURE_INVALID',
        'webhook signature verification failed',
        {},
      );
    }
  }
}

interface ParsedSignatureHeader {
  readonly timestamp: number | null;
  readonly signatures: readonly string[];
}

function parseSignatureHeader(header: string): ParsedSignatureHeader {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const rawPart of header.split(',')) {
    const part = rawPart.trim();
    const eqIdx = part.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = part.slice(0, eqIdx);
    const value = part.slice(eqIdx + 1);
    if (key === 't') {
      // Strict integer check — parseInt('123abc') returns 123 which would be a
      // bug here (an attacker-controlled value could pass a numeric-looking
      // prefix to coast through the tolerance window).
      if (/^\d+$/.test(value)) {
        timestamp = Number.parseInt(value, 10);
      }
    } else if (key === 'v1') {
      signatures.push(value);
    }
  }
  return { timestamp, signatures };
}

function extractInquiryId(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const data = payload['data'];
  if (!isRecord(data)) return null;
  const id = data['id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function extractDateOfBirth(
  fields: Record<string, { readonly value?: string | null | undefined }> | undefined,
): string | null {
  if (fields === undefined) return null;
  const candidates = ['birthdate', 'date-of-birth', 'dob'];
  for (const key of candidates) {
    const field = fields[key];
    if (field === undefined) continue;
    const value = field.value;
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return value;
    }
  }
  return null;
}

function calculateAge(dobIso: string, today: Date): number {
  const parts = dobIso.split('-').map((segment) => Number.parseInt(segment, 10));
  const [year, month, day] = parts;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day)
  ) {
    // The Zod schema and regex in extractDateOfBirth already guard the format,
    // so reaching this branch indicates a programming error — surface it as an
    // invalid DOB rather than crashing on NaN arithmetic.
    throw new KycError('KYC_DOB_MISSING', `birthdate string '${dobIso}' could not be parsed`);
  }
  const todayYear = today.getUTCFullYear();
  const todayMonth = today.getUTCMonth() + 1;
  const todayDay = today.getUTCDate();
  let age = todayYear - year;
  if (todayMonth < month || (todayMonth === month && todayDay < day)) {
    age -= 1;
  }
  return age;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
