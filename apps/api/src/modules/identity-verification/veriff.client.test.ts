/**
 * VeriffClient — pure unit tests, no network, no DB.
 *
 * Three surfaces exercised:
 *
 *   - createSession → POST shape (URL, method, X-AUTH-CLIENT,
 *     X-HMAC-SIGNATURE) and response parsing.
 *   - getDecision → GET shape (signature is HMAC of the session id,
 *     since the body is empty) + maps each Veriff terminal status onto
 *     the typed decision envelope.
 *   - handleWebhook → constant-time HMAC verification + JSON parse +
 *     status → decision mapping. Tampered signatures and bodies are
 *     rejected with `KycError(KYC_WEBHOOK_SIGNATURE_INVALID)`.
 *
 * Every call to `fetch` is intercepted by a hand-rolled spy so we can
 * inspect the outgoing request and choose the response synchronously.
 * The intercept lets us assert HMAC roundtrips without ever leaving the
 * process.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  VeriffClient,
  type CreateVeriffSessionInput,
  type VeriffClientConfig,
} from './veriff.client.js';

const FIXED_NOW = new Date('2026-05-15T20:30:00.000Z');
const API_KEY = 'pk_test_01935f3d';
const SECRET = 'sk_test_01935f3d_secret';
const ORDER_ID = '01935f3d-0000-7000-8000-000000000110';
const VERIFICATION_ID = '01935f3d-0000-7000-8000-0000000001a0';

interface CapturedCall {
  readonly url: string;
  readonly init: RequestInit;
}

function hexHmac(payload: string): string {
  return createHmac('sha256', SECRET).update(payload).digest('hex');
}

function makeFetchSpy(responder: (call: CapturedCall) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const spy: typeof fetch = async (input, init): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const call: CapturedCall = { url, init: init ?? {} };
    calls.push(call);
    return responder(call);
  };
  return { fetch: spy, calls };
}

function makeClient(
  responder: (call: CapturedCall) => Response | Promise<Response>,
  overrides: Partial<VeriffClientConfig> = {},
): { client: VeriffClient; calls: CapturedCall[] } {
  const { fetch: spy, calls } = makeFetchSpy(responder);
  const cfg: VeriffClientConfig = {
    apiKey: API_KEY,
    secret: SECRET,
    fetch: spy,
    clock: (): Date => FIXED_NOW,
    ...overrides,
  };
  return { client: new VeriffClient(cfg), calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SESSION_INPUT: CreateVeriffSessionInput = {
  orderId: ORDER_ID,
  callback: 'https://app.dankdash.com/v1/webhooks/veriff',
  person: { firstName: 'Sam', lastName: 'J.' },
};

describe('VeriffClient.createSession', () => {
  it('POSTs to /v1/sessions with X-AUTH-CLIENT + HMAC of the JSON body', async () => {
    const { client, calls } = makeClient(() =>
      jsonResponse({
        status: 'success',
        verification: {
          id: VERIFICATION_ID,
          url: 'https://magic.veriff.me/v/abc',
          sessionToken: 'tok_test_01935f3d',
        },
      }),
    );

    const session = await client.createSession(SESSION_INPUT);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (!call) {
      expect.fail('expected at least one captured fetch call');
    }
    expect(call.url).toBe('https://stationapi.veriff.com/v1/sessions');
    expect(call.init.method).toBe('POST');

    const headers = call.init.headers as Record<string, string>;
    expect(headers['X-AUTH-CLIENT']).toBe(API_KEY);
    expect(headers['Content-Type']).toBe('application/json');

    // The signature in the header must be the HMAC of the literal
    // outgoing body. Recompute and compare.
    const body = call.init.body as string;
    expect(headers['X-HMAC-SIGNATURE']).toBe(hexHmac(body));

    // Body carries vendorData=orderId so the webhook can round-trip it.
    const parsedBody = JSON.parse(body) as {
      verification: { vendorData: string; callback: string; person: { firstName: string } };
    };
    expect(parsedBody.verification.vendorData).toBe(ORDER_ID);
    expect(parsedBody.verification.callback).toBe(SESSION_INPUT.callback);
    expect(parsedBody.verification.person.firstName).toBe('Sam');

    expect(session).toEqual({
      verificationId: VERIFICATION_ID,
      sessionUrl: 'https://magic.veriff.me/v/abc',
      sessionToken: 'tok_test_01935f3d',
    });
  });

  it('honors apiBaseUrl override (sandbox / proxy / tests)', async () => {
    const { client, calls } = makeClient(
      () =>
        jsonResponse({
          status: 'success',
          verification: {
            id: VERIFICATION_ID,
            url: 'https://example.test/v/abc',
            sessionToken: 'tok',
          },
        }),
      { apiBaseUrl: 'https://stub.veriff.test' },
    );

    await client.createSession(SESSION_INPUT);

    expect(calls[0]?.url).toBe('https://stub.veriff.test/v1/sessions');
  });

  it('raises KycError(KYC_INQUIRY_FAILED) on a non-2xx response', async () => {
    const { client } = makeClient(() => new Response('forbidden', { status: 403 }));

    await expect(client.createSession(SESSION_INPUT)).rejects.toMatchObject({
      code: 'KYC_INQUIRY_FAILED',
      message: expect.stringContaining('403'),
    });
  });

  it('raises KycError when the response is missing verification fields', async () => {
    const { client } = makeClient(() => jsonResponse({ status: 'success', verification: {} }));

    await expect(client.createSession(SESSION_INPUT)).rejects.toMatchObject({
      code: 'KYC_INQUIRY_FAILED',
    });
  });

  it('raises KycError when fetch itself throws (network down)', async () => {
    // node's global fetch throws TypeError on network failure (ECONNRESET,
    // DNS resolve fail, etc). The client must catch that shape too — not
    // just our typed errors — and wrap it in KycError so the global filter
    // renders a clean 502 instead of leaking the lower-level message.
    const { client } = makeClient(() => {
      throw new TypeError('ECONNRESET');
    });

    await expect(client.createSession(SESSION_INPUT)).rejects.toMatchObject({
      code: 'KYC_INQUIRY_FAILED',
    });
  });
});

describe('VeriffClient.getDecision', () => {
  it('GETs /v1/sessions/:id/decision with signature = HMAC(verificationId)', async () => {
    const { client, calls } = makeClient(() =>
      jsonResponse({
        verification: {
          id: VERIFICATION_ID,
          status: 'approved',
          code: 9001,
          vendorData: ORDER_ID,
          decisionTime: '2026-05-15T20:31:00.000Z',
        },
      }),
    );

    const decision = await client.getDecision(VERIFICATION_ID);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    if (!call) {
      expect.fail('expected at least one captured fetch call');
    }
    expect(call.url).toBe(`https://stationapi.veriff.com/v1/sessions/${VERIFICATION_ID}/decision`);
    expect(call.init.method).toBe('GET');

    const headers = call.init.headers as Record<string, string>;
    expect(headers['X-AUTH-CLIENT']).toBe(API_KEY);
    // GET has no body, so the signature is HMAC of the session id itself.
    expect(headers['X-HMAC-SIGNATURE']).toBe(hexHmac(VERIFICATION_ID));

    expect(decision).toEqual({
      type: 'approved',
      verificationId: VERIFICATION_ID,
      orderId: ORDER_ID,
      decisionAt: '2026-05-15T20:31:00.000Z',
      code: 9001,
    });
  });

  it('maps `declined` status → typed declined decision with reason + code', async () => {
    const { client } = makeClient(() =>
      jsonResponse({
        verification: {
          id: VERIFICATION_ID,
          status: 'declined',
          code: 9102,
          reason: 'physical_document_not_used',
          vendorData: ORDER_ID,
          decisionTime: '2026-05-15T20:32:00.000Z',
        },
      }),
    );

    const decision = await client.getDecision(VERIFICATION_ID);

    expect(decision).toEqual({
      type: 'declined',
      verificationId: VERIFICATION_ID,
      orderId: ORDER_ID,
      decisionAt: '2026-05-15T20:32:00.000Z',
      reason: 'physical_document_not_used',
      code: 9102,
    });
  });

  it('maps `resubmission_requested` → resubmission decision', async () => {
    const { client } = makeClient(() =>
      jsonResponse({
        verification: {
          id: VERIFICATION_ID,
          status: 'resubmission_requested',
          code: 9103,
          reason: 'video_quality_insufficient',
          vendorData: ORDER_ID,
        },
      }),
    );

    const decision = await client.getDecision(VERIFICATION_ID);

    expect(decision.type).toBe('resubmission');
    if (decision.type !== 'resubmission') {
      expect.fail('expected resubmission decision');
    }
    expect(decision.reason).toBe('video_quality_insufficient');
  });

  it('maps `abandoned` / `expired` → expired decision', async () => {
    const { client } = makeClient(() =>
      jsonResponse({
        verification: {
          id: VERIFICATION_ID,
          status: 'expired',
          code: 9104,
          vendorData: ORDER_ID,
        },
      }),
    );

    const decision = await client.getDecision(VERIFICATION_ID);

    expect(decision.type).toBe('expired');
  });

  it('returns { type: pending } on HTTP 404 (decision not rendered yet)', async () => {
    const { client } = makeClient(() => new Response('not found', { status: 404 }));

    const decision = await client.getDecision(VERIFICATION_ID);

    expect(decision).toEqual({ type: 'pending', verificationId: VERIFICATION_ID });
  });

  it('refuses a verification id mismatch (cache / upstream confusion guard)', async () => {
    const wrongId = '01935f3d-0000-7000-8000-0000000099aa';
    const { client } = makeClient(() =>
      jsonResponse({
        verification: {
          id: wrongId,
          status: 'approved',
          vendorData: ORDER_ID,
        },
      }),
    );

    await expect(client.getDecision(VERIFICATION_ID)).rejects.toMatchObject({
      code: 'KYC_WEBHOOK_PAYLOAD_INVALID',
    });
  });

  it('raises KycError on non-2xx non-404 responses', async () => {
    const { client } = makeClient(() => new Response('boom', { status: 500 }));

    await expect(client.getDecision(VERIFICATION_ID)).rejects.toMatchObject({
      code: 'KYC_INQUIRY_FAILED',
    });
  });
});

describe('VeriffClient.handleWebhook', () => {
  function approvedBody(): string {
    return JSON.stringify({
      status: 'success',
      verification: {
        id: VERIFICATION_ID,
        status: 'approved',
        code: 9001,
        vendorData: ORDER_ID,
        decisionTime: '2026-05-15T20:33:00.000Z',
      },
    });
  }

  it('accepts a payload whose HMAC matches the signature header', () => {
    const { client } = makeClient(() => new Response('', { status: 204 }));
    const body = approvedBody();

    const decision = client.handleWebhook(body, hexHmac(body));

    expect(decision).toEqual({
      type: 'approved',
      verificationId: VERIFICATION_ID,
      orderId: ORDER_ID,
      decisionAt: '2026-05-15T20:33:00.000Z',
      code: 9001,
    });
  });

  it('rejects a payload whose body was tampered after signing', () => {
    const { client } = makeClient(() => new Response('', { status: 204 }));
    const body = approvedBody();
    const tampered = body.replace('approved', 'declined');

    expect(() => client.handleWebhook(tampered, hexHmac(body))).toThrow(
      expect.objectContaining({ code: 'KYC_WEBHOOK_SIGNATURE_INVALID' }),
    );
  });

  it('rejects when the signature header itself is wrong', () => {
    const { client } = makeClient(() => new Response('', { status: 204 }));
    const body = approvedBody();
    const wrongSecret = createHmac('sha256', 'sk_attacker').update(body).digest('hex');

    expect(() => client.handleWebhook(body, wrongSecret)).toThrow(
      expect.objectContaining({ code: 'KYC_WEBHOOK_SIGNATURE_INVALID' }),
    );
  });

  it('rejects when the signature header is empty', () => {
    const { client } = makeClient(() => new Response('', { status: 204 }));

    expect(() => client.handleWebhook(approvedBody(), '')).toThrow(
      expect.objectContaining({ code: 'KYC_WEBHOOK_SIGNATURE_INVALID' }),
    );
  });

  it('rejects when the signature header is not valid hex', () => {
    const { client } = makeClient(() => new Response('', { status: 204 }));
    const body = approvedBody();

    // Buffer.from with 'hex' silently truncates on a non-hex char, which
    // means a sufficiently weird header could pass the length check.
    // Our timing-safe compare still rejects it because the resulting
    // buffer will not match the HMAC.
    expect(() => client.handleWebhook(body, '!!!not-hex!!!')).toThrow(
      expect.objectContaining({ code: 'KYC_WEBHOOK_SIGNATURE_INVALID' }),
    );
  });

  it('rejects when the JSON is malformed (signature valid but body broken)', () => {
    const { client } = makeClient(() => new Response('', { status: 204 }));
    const malformed = '{not-json';

    expect(() => client.handleWebhook(malformed, hexHmac(malformed))).toThrow(
      expect.objectContaining({ code: 'KYC_WEBHOOK_PAYLOAD_INVALID' }),
    );
  });

  it('routes a webhook-borne declined decision through the same envelope shape', () => {
    const { client } = makeClient(() => new Response('', { status: 204 }));
    const body = JSON.stringify({
      verification: {
        id: VERIFICATION_ID,
        status: 'declined',
        code: 9102,
        reason: 'physical_document_not_used',
        vendorData: ORDER_ID,
        decisionTime: '2026-05-15T20:34:00.000Z',
      },
    });

    const decision = client.handleWebhook(body, hexHmac(body));

    expect(decision).toEqual({
      type: 'declined',
      verificationId: VERIFICATION_ID,
      orderId: ORDER_ID,
      decisionAt: '2026-05-15T20:34:00.000Z',
      reason: 'physical_document_not_used',
      code: 9102,
    });
  });

  it('treats a payload with a null vendorData as orderId=null (webhook fallback path)', () => {
    const { client } = makeClient(() => new Response('', { status: 204 }));
    const body = JSON.stringify({
      verification: {
        id: VERIFICATION_ID,
        status: 'approved',
        code: 9001,
        vendorData: null,
        decisionTime: '2026-05-15T20:35:00.000Z',
      },
    });

    const decision = client.handleWebhook(body, hexHmac(body));

    expect(decision.type).toBe('approved');
    if (decision.type !== 'approved') {
      expect.fail('expected approved decision');
    }
    expect(decision.orderId).toBeNull();
  });
});
