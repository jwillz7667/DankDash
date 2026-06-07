/**
 * Unit tests for DriverOffersController.
 *
 * The controller is a thin pass-through to DriverOffersService — it owns
 * the DriverContext plumbing, URL param shape, and rate-limit metadata.
 * Guard wiring (DriverContextGuard, the global JwtAuthGuard) is verified
 * at the module-composition level; these tests bypass the guard and
 * inject a synthetic context, same pattern as the shift / vendor-self
 * controller tests.
 */
import { describe, expect, it } from 'vitest';
import { DriverOffersController } from './driver-offers.controller.js';
import type { DriverOffersService } from './driver-offers.service.js';
import type { DriverContext } from '../context/driver-context.types.js';
import type {
  DeclineOfferRequest,
  DispatchOfferResponse,
  PendingOffersResponse,
} from './dto/index.js';

const CTX: DriverContext = {
  driverId: '01935f3d-0000-7000-8000-0000000000d1',
  userId: '01935f3d-0000-7000-8000-0000000000a1',
  currentStatus: 'online',
  currentOrderId: null,
};

const OFFER_ID = '01935f3d-0000-7000-8000-0000000000e1';

const ACCEPTED_OFFER: DispatchOfferResponse = {
  id: OFFER_ID,
  orderId: '01935f3d-0000-7000-8000-000000000001',
  driverId: CTX.driverId,
  offeredAt: '2026-05-19T14:30:00.000Z',
  expiresAt: '2026-05-19T14:30:25.000Z',
  payoutEstimateCents: 1200,
  distanceMiles: '2.50',
  status: 'accepted',
  respondedAt: '2026-05-19T14:30:05.000Z',
  declineReason: null,
};

const DECLINED_OFFER: DispatchOfferResponse = {
  ...ACCEPTED_OFFER,
  status: 'declined',
  declineReason: 'too far',
};

const PENDING_OFFERS: PendingOffersResponse = {
  offers: [{ ...ACCEPTED_OFFER, status: 'offered', respondedAt: null }],
};

class FakeOffersService {
  public acceptCalls: { ctx: DriverContext; id: string }[] = [];
  public declineCalls: { ctx: DriverContext; id: string; body: DeclineOfferRequest }[] = [];
  public listPendingCalls: { ctx: DriverContext }[] = [];

  listPending = (ctx: DriverContext): Promise<PendingOffersResponse> => {
    this.listPendingCalls.push({ ctx });
    return Promise.resolve(PENDING_OFFERS);
  };

  accept = (ctx: DriverContext, id: string): Promise<DispatchOfferResponse> => {
    this.acceptCalls.push({ ctx, id });
    return Promise.resolve(ACCEPTED_OFFER);
  };

  decline = (
    ctx: DriverContext,
    id: string,
    body: DeclineOfferRequest,
  ): Promise<DispatchOfferResponse> => {
    this.declineCalls.push({ ctx, id, body });
    return Promise.resolve({ ...DECLINED_OFFER, declineReason: body.reason ?? null });
  };
}

describe('DriverOffersController.listPending', () => {
  it('forwards the context to the service and returns the pending-offers envelope', async () => {
    const svc = new FakeOffersService();
    const controller = new DriverOffersController(svc as unknown as DriverOffersService);

    const res = await controller.listPending(CTX);

    expect(svc.listPendingCalls).toEqual([{ ctx: CTX }]);
    expect(res).toEqual(PENDING_OFFERS);
  });
});

describe('DriverOffersController.accept', () => {
  it('forwards the context + URL id to the service and returns the accepted offer', async () => {
    const svc = new FakeOffersService();
    const controller = new DriverOffersController(svc as unknown as DriverOffersService);

    const res = await controller.accept(CTX, OFFER_ID);

    expect(svc.acceptCalls).toEqual([{ ctx: CTX, id: OFFER_ID }]);
    expect(res).toEqual(ACCEPTED_OFFER);
  });
});

describe('DriverOffersController.decline', () => {
  it('forwards the context, URL id, and body to the service', async () => {
    const svc = new FakeOffersService();
    const controller = new DriverOffersController(svc as unknown as DriverOffersService);
    const body: DeclineOfferRequest = { reason: 'too far' };

    const res = await controller.decline(CTX, OFFER_ID, body);

    expect(svc.declineCalls).toEqual([{ ctx: CTX, id: OFFER_ID, body }]);
    expect(res.status).toBe('declined');
    expect(res.declineReason).toBe('too far');
  });

  it('passes an empty body through (decline without a reason)', async () => {
    const svc = new FakeOffersService();
    const controller = new DriverOffersController(svc as unknown as DriverOffersService);

    const res = await controller.decline(CTX, OFFER_ID, {});

    expect(svc.declineCalls).toEqual([{ ctx: CTX, id: OFFER_ID, body: {} }]);
    expect(res.declineReason).toBeNull();
  });
});
