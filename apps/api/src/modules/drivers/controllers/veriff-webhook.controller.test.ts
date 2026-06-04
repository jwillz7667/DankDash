/**
 * Unit tests for VeriffWebhookController — the HMAC gate + dispatch.
 *
 * The controller is intentionally a two-statement surface: pull the
 * raw body, pull the signature header, hand both to VeriffClient
 * (which verifies HMAC + parses the envelope), then forward the
 * resulting decision to DriverIdScanService. The "real" write path
 * (idempotent age_verifications insert + order patch + status
 * transition) lives in DriverIdScanService and is covered by
 * driver-id-scan.service.test.ts; HMAC verification + Zod parsing
 * lives in VeriffClient and is covered by its own suite once the
 * client tests land.
 *
 * What we lock down here:
 *
 *   - Happy path: a non-empty raw body + signature header dispatches
 *     through VeriffClient.handleWebhook → DriverIdScanService.applyWebhookDecision.
 *   - Missing rawBody → KYC_WEBHOOK_PAYLOAD_INVALID *before* reaching
 *     the client (cheap rejection — Veriff treats 4xx as terminal).
 *   - Empty rawBody (zero-length Buffer) → same KYC_WEBHOOK_PAYLOAD_INVALID.
 *   - Missing `x-hmac-signature` header → KYC_WEBHOOK_SIGNATURE_INVALID.
 *   - Header sent as an array (Fastify allows that for headers) → the
 *     first element is used so HMAC verification still has a string
 *     to hand to VeriffClient.
 *   - When VeriffClient throws (HMAC mismatch / malformed JSON), the
 *     error propagates and the driver-id-scan service is never invoked.
 */
import { KycError } from '@dankdash/types';
import { describe, expect, it } from 'vitest';
import { VeriffWebhookController } from './veriff-webhook.controller.js';
import type { VeriffClient, VeriffDecision } from '../../identity-verification/veriff.client.js';
import type { DriverIdScanService } from '../services/driver-id-scan.service.js';
import type { RawBodyRequest } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

const APPROVED_DECISION: VeriffDecision = {
  type: 'approved',
  verificationId: '01935f3d-0000-7000-8000-0000000007a1',
  orderId: '01935f3d-0000-7000-8000-0000000007b1',
  decisionAt: '2026-05-19T20:30:00.000Z',
  code: 9001,
};

class FakeVeriffClient {
  public calls: { rawBody: string; signature: string }[] = [];
  public nextDecision: VeriffDecision = APPROVED_DECISION;
  public nextError: KycError | null = null;

  handleWebhook = (rawBody: string, signature: string): VeriffDecision => {
    this.calls.push({ rawBody, signature });
    if (this.nextError !== null) throw this.nextError;
    return this.nextDecision;
  };
}

class FakeDriverIdScanService {
  public calls: VeriffDecision[] = [];

  applyWebhookDecision = (decision: VeriffDecision): Promise<void> => {
    this.calls.push(decision);
    return Promise.resolve();
  };
}

function makeRequest(
  rawBody: Buffer | undefined,
  headers: Record<string, string | string[] | undefined>,
): RawBodyRequest<FastifyRequest> {
  return { rawBody, headers } as unknown as RawBodyRequest<FastifyRequest>;
}

function makeController(): {
  controller: VeriffWebhookController;
  veriff: FakeVeriffClient;
  driverIdScan: FakeDriverIdScanService;
} {
  const veriff = new FakeVeriffClient();
  const driverIdScan = new FakeDriverIdScanService();
  const controller = new VeriffWebhookController(
    veriff as unknown as VeriffClient,
    driverIdScan as unknown as DriverIdScanService,
  );
  return { controller, veriff, driverIdScan };
}

describe('VeriffWebhookController', () => {
  it('verifies the signature via VeriffClient and forwards the decision to DriverIdScanService', async () => {
    const { controller, veriff, driverIdScan } = makeController();
    const rawJson = '{"verification":{"id":"v_1","status":"approved"}}';
    const raw = Buffer.from(rawJson, 'utf8');
    const signature = 'a'.repeat(64);

    await controller.webhook(makeRequest(raw, { 'x-hmac-signature': signature }));

    expect(veriff.calls).toEqual([{ rawBody: rawJson, signature }]);
    expect(driverIdScan.calls).toEqual([APPROVED_DECISION]);
  });

  it('decodes the raw body as UTF-8 before handing it to the client (signature stability)', async () => {
    // The HMAC is computed over the exact bytes Veriff sent. We must
    // pass the same byte sequence through — re-serializing via
    // JSON.parse → JSON.stringify would reorder keys and break the
    // signature. The controller calls Buffer#toString('utf8'); this
    // test pins that contract by asserting the bytes round-trip
    // unchanged through a representative payload.
    const { controller, veriff } = makeController();
    const rawJson = '{"verification":{"id":"v_2","status":"declined","reason":"face_mismatch"}}';
    const raw = Buffer.from(rawJson, 'utf8');

    await controller.webhook(makeRequest(raw, { 'x-hmac-signature': 'b'.repeat(64) }));

    expect(veriff.calls[0]?.rawBody).toBe(rawJson);
  });

  it('accepts the signature header when delivered as an array (Fastify multi-value form)', async () => {
    const { controller, veriff } = makeController();
    const sig = 'c'.repeat(64);
    const raw = Buffer.from('{"verification":{"id":"v_3","status":"approved"}}', 'utf8');

    await controller.webhook(makeRequest(raw, { 'x-hmac-signature': [sig, 'second'] }));

    expect(veriff.calls[0]?.signature).toBe(sig);
  });

  it('refuses the call before reaching VeriffClient when the raw body is missing', async () => {
    const { controller, veriff, driverIdScan } = makeController();

    await expect(
      controller.webhook(makeRequest(undefined, { 'x-hmac-signature': 'a'.repeat(64) })),
    ).rejects.toMatchObject({ code: 'KYC_WEBHOOK_PAYLOAD_INVALID' });

    expect(veriff.calls).toHaveLength(0);
    expect(driverIdScan.calls).toHaveLength(0);
  });

  it('refuses the call when the raw body is an empty buffer', async () => {
    const { controller, veriff } = makeController();

    await expect(
      controller.webhook(makeRequest(Buffer.alloc(0), { 'x-hmac-signature': 'a'.repeat(64) })),
    ).rejects.toBeInstanceOf(KycError);
    expect(veriff.calls).toHaveLength(0);
  });

  it('refuses the call before reaching VeriffClient when the x-hmac-signature header is missing', async () => {
    const { controller, veriff, driverIdScan } = makeController();
    const raw = Buffer.from('{"verification":{"id":"v_4","status":"approved"}}', 'utf8');

    await expect(controller.webhook(makeRequest(raw, {}))).rejects.toMatchObject({
      code: 'KYC_WEBHOOK_SIGNATURE_INVALID',
    });

    expect(veriff.calls).toHaveLength(0);
    expect(driverIdScan.calls).toHaveLength(0);
  });

  it('refuses an empty-string signature header — `header: ""` is treated the same as missing', async () => {
    const { controller, veriff } = makeController();
    const raw = Buffer.from('{"verification":{"id":"v_5","status":"approved"}}', 'utf8');

    await expect(
      controller.webhook(makeRequest(raw, { 'x-hmac-signature': '' })),
    ).rejects.toMatchObject({ code: 'KYC_WEBHOOK_SIGNATURE_INVALID' });

    expect(veriff.calls).toHaveLength(0);
  });

  it('propagates KycError from VeriffClient and never invokes DriverIdScanService', async () => {
    const { controller, veriff, driverIdScan } = makeController();
    veriff.nextError = new KycError(
      'KYC_WEBHOOK_SIGNATURE_INVALID',
      'Veriff webhook signature verification failed',
    );
    const raw = Buffer.from('{"verification":{"id":"v_6","status":"approved"}}', 'utf8');

    await expect(
      controller.webhook(makeRequest(raw, { 'x-hmac-signature': 'bad-signature' })),
    ).rejects.toMatchObject({ code: 'KYC_WEBHOOK_SIGNATURE_INVALID' });

    expect(veriff.calls).toHaveLength(1);
    expect(driverIdScan.calls).toHaveLength(0);
  });

  it('forwards a declined decision through to DriverIdScanService unchanged', async () => {
    // The controller does not branch on decision type — every typed
    // decision routes through one write surface. This pin protects
    // that contract.
    const { controller, veriff, driverIdScan } = makeController();
    const declined: VeriffDecision = {
      type: 'declined',
      verificationId: '01935f3d-0000-7000-8000-0000000007a2',
      orderId: '01935f3d-0000-7000-8000-0000000007b2',
      decisionAt: '2026-05-19T20:35:00.000Z',
      reason: 'document_expired',
      code: 9102,
    };
    veriff.nextDecision = declined;
    const raw = Buffer.from('{"verification":{"id":"v_7","status":"declined"}}', 'utf8');

    await controller.webhook(makeRequest(raw, { 'x-hmac-signature': 'd'.repeat(64) }));

    expect(driverIdScan.calls).toEqual([declined]);
  });
});
