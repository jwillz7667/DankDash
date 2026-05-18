/**
 * Unit tests for PersonaService.
 *
 * No network. We inject a `fetch` stub for createInquiry tests and inject a
 * fixed clock so HMAC timestamp checks are deterministic. The webhook tests
 * compute valid signatures by running the same HMAC the production code does,
 * which keeps the test honest — if we ever change the signing scheme both
 * production and test must agree.
 */
import { createHmac } from 'node:crypto';
import { KycError } from '@dankdash/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MIN_AGE_YEARS,
  PersonaService,
  type PersonaServiceConfig,
  type WebhookOutcome,
} from './persona.service.js';

const FIXED_NOW = new Date('2026-05-18T12:00:00.000Z');
const WEBHOOK_SECRET = 'whsec_super_secret_value_for_tests_only';
const API_KEY = 'persona_test_api_key';
const TEMPLATE_ID = 'tmpl_test123';

function makeService(overrides: Partial<PersonaServiceConfig> = {}): {
  service: PersonaService;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const fetchMock = vi.fn();
  const service = new PersonaService({
    apiKey: API_KEY,
    templateId: TEMPLATE_ID,
    webhookSecret: WEBHOOK_SECRET,
    apiBaseUrl: 'https://withpersona.test',
    hostedFlowBaseUrl: 'https://withpersona.test/verify',
    fetch: fetchMock,
    clock: (): Date => FIXED_NOW,
    ...overrides,
  });
  return { service, fetchMock };
}

function signWebhook(rawBody: string, timestamp: number, secret = WEBHOOK_SECRET): string {
  const sig = createHmac('sha256', secret)
    .update(`${String(timestamp)}.${rawBody}`)
    .digest('hex');
  return `t=${String(timestamp)},v1=${sig}`;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function inquiryEvent(
  name: string,
  options: {
    readonly inquiryId?: string;
    readonly referenceId?: string | null;
    readonly birthdate?: string | null;
    readonly birthdateKey?: 'birthdate' | 'date-of-birth' | 'dob';
    readonly extraFields?: Record<string, { value: string | null }>;
  } = {},
): string {
  const fields: Record<string, { value: string | null }> = { ...options.extraFields };
  if (options.birthdate !== undefined) {
    const key = options.birthdateKey ?? 'birthdate';
    fields[key] = { value: options.birthdate };
  }
  return JSON.stringify({
    data: {
      type: 'event',
      id: 'evt_test_001',
      attributes: {
        name,
        payload: {
          data: {
            type: 'inquiry',
            id: options.inquiryId ?? 'inq_test_001',
            attributes: {
              'reference-id':
                options.referenceId === undefined ? 'user_uuid_001' : options.referenceId,
              fields,
            },
          },
        },
      },
    },
  });
}

describe('PersonaService.createInquiry', () => {
  let service: PersonaService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ service, fetchMock } = makeService());
  });

  it('POSTs to the inquiries endpoint with template id, reference id, and bearer auth', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { data: { id: 'inq_abc123' } }));

    await service.createInquiry('user_42');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://withpersona.test/api/v1/inquiries');
    expect(init).toBeDefined();
    const opts = init as RequestInit;
    expect(opts.method).toBe('POST');
    const headers = opts.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${API_KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Persona-Version']).toBeDefined();
    const body = JSON.parse(opts.body as string) as {
      data: { attributes: Record<string, string> };
    };
    expect(body.data.attributes['inquiry-template-id']).toBe(TEMPLATE_ID);
    expect(body.data.attributes['reference-id']).toBe('user_42');
  });

  it('returns the inquiry id and a hosted flow URL containing the reference id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { data: { id: 'inq_abc123' } }));

    const result = await service.createInquiry('user_42');

    expect(result.inquiryId).toBe('inq_abc123');
    expect(result.hostedFlowUrl).toBe(
      'https://withpersona.test/verify?inquiry-id=inq_abc123&reference-id=user_42',
    );
  });

  it('URL-encodes the reference id and inquiry id when building the hosted URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { data: { id: 'inq with space' } }));

    const result = await service.createInquiry('user/42 weird');

    expect(result.hostedFlowUrl).toBe(
      'https://withpersona.test/verify?inquiry-id=inq%20with%20space&reference-id=user%2F42%20weird',
    );
  });

  it('raises KYC_INQUIRY_FAILED with the upstream status on non-2xx', async () => {
    fetchMock.mockResolvedValue(new Response('upstream broken', { status: 503 }));

    try {
      await service.createInquiry('user_42');
      expect.unreachable('expected KycError');
    } catch (err) {
      expect(err).toBeInstanceOf(KycError);
      const kyc = err as KycError;
      expect(kyc.code).toBe('KYC_INQUIRY_FAILED');
      expect(kyc.statusCode).toBe(502);
      expect(kyc.details).toMatchObject({ userId: 'user_42', status: 503 });
    }
  });

  it('raises KYC_INQUIRY_FAILED when fetch itself rejects (network error)', async () => {
    const cause = new Error('ECONNREFUSED');
    fetchMock.mockRejectedValue(cause);

    try {
      await service.createInquiry('user_42');
      expect.unreachable('expected KycError');
    } catch (err) {
      expect(err).toBeInstanceOf(KycError);
      const kyc = err as KycError;
      expect(kyc.code).toBe('KYC_INQUIRY_FAILED');
      expect(kyc.cause).toBe(cause);
    }
  });

  it('raises KYC_INQUIRY_FAILED when the response body is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 201 }));

    await expect(service.createInquiry('user_42')).rejects.toMatchObject({
      code: 'KYC_INQUIRY_FAILED',
    });
  });

  it('raises KYC_INQUIRY_FAILED when the JSON response is missing data.id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { data: {} }));

    await expect(service.createInquiry('user_42')).rejects.toMatchObject({
      code: 'KYC_INQUIRY_FAILED',
      details: expect.objectContaining({ userId: 'user_42' }) as unknown,
    });
  });
});

describe('PersonaService.handleWebhook — signature verification', () => {
  it('accepts a valid signature for a well-formed completed event', () => {
    const { service } = makeService();
    const body = inquiryEvent('inquiry.completed', { birthdate: '1990-01-15' });
    const header = signWebhook(body, Math.floor(FIXED_NOW.getTime() / 1000));

    const outcome = service.handleWebhook(body, header);
    expect(outcome.type).toBe('kyc.completed');
  });

  it('accepts a signature header containing multiple v1= entries (key rotation)', () => {
    const { service } = makeService();
    const body = inquiryEvent('inquiry.completed', { birthdate: '1990-01-15' });
    const ts = Math.floor(FIXED_NOW.getTime() / 1000);
    const valid = createHmac('sha256', WEBHOOK_SECRET)
      .update(`${String(ts)}.${body}`)
      .digest('hex');
    const decoy = '0'.repeat(valid.length);
    // Persona puts the new key first during rotation, but we must accept any
    // matching v1= regardless of position.
    const header = `t=${String(ts)},v1=${decoy},v1=${valid}`;

    const outcome = service.handleWebhook(body, header);
    expect(outcome.type).toBe('kyc.completed');
  });

  it('rejects when the signature header has no t= component', () => {
    const { service } = makeService();
    const body = inquiryEvent('inquiry.completed', { birthdate: '1990-01-15' });
    expect(() => service.handleWebhook(body, 'v1=deadbeef')).toThrow(KycError);
  });

  it('rejects when the signature header has no v1= component', () => {
    const { service } = makeService();
    const body = inquiryEvent('inquiry.completed', { birthdate: '1990-01-15' });
    const ts = Math.floor(FIXED_NOW.getTime() / 1000);
    try {
      service.handleWebhook(body, `t=${String(ts)}`);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(KycError);
      expect((err as KycError).code).toBe('KYC_WEBHOOK_SIGNATURE_INVALID');
    }
  });

  it('rejects a signature header with a non-numeric timestamp prefix attack', () => {
    const { service } = makeService();
    const body = inquiryEvent('inquiry.completed', { birthdate: '1990-01-15' });
    const ts = Math.floor(FIXED_NOW.getTime() / 1000);
    const sig = createHmac('sha256', WEBHOOK_SECRET)
      .update(`${String(ts)}.${body}`)
      .digest('hex');
    // `123abc` would pass a naive parseInt(value, 10) → 123. Strict regex
    // rejects it before we can be fooled into the past.
    try {
      service.handleWebhook(body, `t=${String(ts)}abc,v1=${sig}`);
      expect.unreachable();
    } catch (err) {
      expect((err as KycError).code).toBe('KYC_WEBHOOK_SIGNATURE_INVALID');
    }
  });

  it('rejects a forged signature (wrong secret)', () => {
    const { service } = makeService();
    const body = inquiryEvent('inquiry.completed', { birthdate: '1990-01-15' });
    const ts = Math.floor(FIXED_NOW.getTime() / 1000);
    const forged = signWebhook(body, ts, 'attacker_secret');

    try {
      service.handleWebhook(body, forged);
      expect.unreachable();
    } catch (err) {
      expect((err as KycError).code).toBe('KYC_WEBHOOK_SIGNATURE_INVALID');
    }
  });

  it('rejects a tampered body even when signature timestamp is fresh', () => {
    const { service } = makeService();
    const body = inquiryEvent('inquiry.completed', { birthdate: '1990-01-15' });
    const ts = Math.floor(FIXED_NOW.getTime() / 1000);
    const header = signWebhook(body, ts);

    expect(() => service.handleWebhook(`${body}{"extra":"junk"}`, header)).toThrow(KycError);
  });

  it('rejects a timestamp outside the tolerance window', () => {
    const { service } = makeService();
    const body = inquiryEvent('inquiry.completed', { birthdate: '1990-01-15' });
    const staleTs = Math.floor(FIXED_NOW.getTime() / 1000) - 600; // 10 min old
    const header = signWebhook(body, staleTs);

    try {
      service.handleWebhook(body, header);
      expect.unreachable();
    } catch (err) {
      expect((err as KycError).code).toBe('KYC_WEBHOOK_TIMESTAMP_STALE');
    }
  });

  it('accepts a timestamp exactly at the tolerance boundary', () => {
    const { service } = makeService();
    const body = inquiryEvent('inquiry.completed', { birthdate: '1990-01-15' });
    const edgeTs = Math.floor(FIXED_NOW.getTime() / 1000) - 300;
    const header = signWebhook(body, edgeTs);

    const outcome = service.handleWebhook(body, header);
    expect(outcome.type).toBe('kyc.completed');
  });

  it('rejects malformed hex in a v1= signature without crashing', () => {
    const { service } = makeService();
    const body = inquiryEvent('inquiry.completed', { birthdate: '1990-01-15' });
    const ts = Math.floor(FIXED_NOW.getTime() / 1000);

    try {
      service.handleWebhook(body, `t=${String(ts)},v1=not-hex-zzz`);
      expect.unreachable();
    } catch (err) {
      expect((err as KycError).code).toBe('KYC_WEBHOOK_SIGNATURE_INVALID');
    }
  });
});

describe('PersonaService.handleWebhook — payload parsing + dispatch', () => {
  function signedHandle(body: string): WebhookOutcome {
    const { service } = makeService();
    const ts = Math.floor(FIXED_NOW.getTime() / 1000);
    return service.handleWebhook(body, signWebhook(body, ts));
  }

  it('inquiry.completed with valid DOB → kyc.completed outcome', () => {
    const body = inquiryEvent('inquiry.completed', {
      inquiryId: 'inq_xyz',
      referenceId: 'user_aaa',
      birthdate: '1990-01-15',
    });
    expect(signedHandle(body)).toEqual({
      type: 'kyc.completed',
      userId: 'user_aaa',
      inquiryId: 'inq_xyz',
      dateOfBirth: '1990-01-15',
    });
  });

  it('inquiry.approved is treated as kyc.completed', () => {
    const body = inquiryEvent('inquiry.approved', {
      inquiryId: 'inq_xyz',
      referenceId: 'user_aaa',
      birthdate: '1990-01-15',
    });
    const outcome = signedHandle(body);
    expect(outcome.type).toBe('kyc.completed');
  });

  it('extracts DOB from the `date-of-birth` field alias', () => {
    const body = inquiryEvent('inquiry.completed', {
      birthdate: '1990-01-15',
      birthdateKey: 'date-of-birth',
    });
    const outcome = signedHandle(body);
    if (outcome.type === 'kyc.completed') {
      expect(outcome.dateOfBirth).toBe('1990-01-15');
    } else {
      expect.unreachable('expected kyc.completed');
    }
  });

  it('inquiry.failed → kyc.failed outcome', () => {
    const body = inquiryEvent('inquiry.failed', {
      inquiryId: 'inq_x',
      referenceId: 'user_a',
    });
    expect(signedHandle(body)).toEqual({
      type: 'kyc.failed',
      userId: 'user_a',
      inquiryId: 'inq_x',
    });
  });

  it('inquiry.declined is treated as kyc.failed', () => {
    const body = inquiryEvent('inquiry.declined', {
      inquiryId: 'inq_x',
      referenceId: 'user_a',
    });
    const outcome = signedHandle(body);
    expect(outcome.type).toBe('kyc.failed');
  });

  it('inquiry.expired → kyc.expired outcome', () => {
    const body = inquiryEvent('inquiry.expired', {
      inquiryId: 'inq_x',
      referenceId: 'user_a',
    });
    expect(signedHandle(body)).toEqual({
      type: 'kyc.expired',
      userId: 'user_a',
      inquiryId: 'inq_x',
    });
  });

  it('other event names are returned as ignored', () => {
    const body = inquiryEvent('inquiry.started', { referenceId: 'user_a' });
    expect(signedHandle(body)).toEqual({ type: 'ignored', eventName: 'inquiry.started' });
  });

  it('raises KYC_WEBHOOK_PAYLOAD_INVALID when body is not JSON', () => {
    const { service } = makeService();
    const ts = Math.floor(FIXED_NOW.getTime() / 1000);
    const garbage = 'not-json-at-all';
    try {
      service.handleWebhook(garbage, signWebhook(garbage, ts));
      expect.unreachable();
    } catch (err) {
      expect((err as KycError).code).toBe('KYC_WEBHOOK_PAYLOAD_INVALID');
    }
  });

  it('raises KYC_WEBHOOK_PAYLOAD_INVALID when envelope shape is wrong', () => {
    const { service } = makeService();
    const ts = Math.floor(FIXED_NOW.getTime() / 1000);
    const wrongShape = JSON.stringify({ foo: 'bar' });
    try {
      service.handleWebhook(wrongShape, signWebhook(wrongShape, ts));
      expect.unreachable();
    } catch (err) {
      expect((err as KycError).code).toBe('KYC_WEBHOOK_PAYLOAD_INVALID');
    }
  });

  it('raises KYC_WEBHOOK_PAYLOAD_INVALID when completed event has null reference-id', () => {
    const body = inquiryEvent('inquiry.completed', {
      birthdate: '1990-01-15',
      referenceId: null,
    });
    try {
      signedHandle(body);
      expect.unreachable();
    } catch (err) {
      expect((err as KycError).code).toBe('KYC_WEBHOOK_PAYLOAD_INVALID');
    }
  });

  it('raises KYC_DOB_MISSING when completed event has no birthdate field', () => {
    const body = inquiryEvent('inquiry.completed', { referenceId: 'user_a' });
    try {
      signedHandle(body);
      expect.unreachable();
    } catch (err) {
      expect((err as KycError).code).toBe('KYC_DOB_MISSING');
    }
  });

  it('raises KYC_DOB_MISSING when birthdate value is malformed', () => {
    const body = inquiryEvent('inquiry.completed', {
      referenceId: 'user_a',
      birthdate: 'not-a-date',
    });
    try {
      signedHandle(body);
      expect.unreachable();
    } catch (err) {
      // The format check in extractDateOfBirth turns this into a missing DOB.
      expect((err as KycError).code).toBe('KYC_DOB_MISSING');
    }
  });

  it('raises KYC_AGE_UNDER_MINIMUM when applicant is under 21', () => {
    // FIXED_NOW = 2026-05-18; an applicant born 2007-01-01 is 19.
    const body = inquiryEvent('inquiry.completed', {
      referenceId: 'user_a',
      birthdate: '2007-01-01',
    });
    try {
      signedHandle(body);
      expect.unreachable();
    } catch (err) {
      expect((err as KycError).code).toBe('KYC_AGE_UNDER_MINIMUM');
      const details = (err as KycError).details as { age: number; minimum: number };
      expect(details.age).toBe(19);
      expect(details.minimum).toBe(MIN_AGE_YEARS);
    }
  });

  it('accepts an applicant who turns 21 exactly today', () => {
    // FIXED_NOW = 2026-05-18 → born 2005-05-18 → exactly 21.
    const body = inquiryEvent('inquiry.completed', {
      referenceId: 'user_a',
      birthdate: '2005-05-18',
    });
    expect(signedHandle(body).type).toBe('kyc.completed');
  });

  it('rejects an applicant whose 21st birthday is tomorrow', () => {
    // FIXED_NOW = 2026-05-18 → born 2005-05-19 → age 20 today.
    const body = inquiryEvent('inquiry.completed', {
      referenceId: 'user_a',
      birthdate: '2005-05-19',
    });
    try {
      signedHandle(body);
      expect.unreachable();
    } catch (err) {
      expect((err as KycError).code).toBe('KYC_AGE_UNDER_MINIMUM');
      expect(((err as KycError).details as { age: number }).age).toBe(20);
    }
  });
});
