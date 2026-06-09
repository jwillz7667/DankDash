/**
 * Unit tests for CheckoutCapabilitiesController.
 *
 * Verifies the controller returns the service's capabilities snapshot
 * unchanged for both flag states. Guard wiring (JwtAuthGuard global,
 * RolesGuard) is a module-composition concern, not tested here.
 */
import { describe, expect, it } from 'vitest';
import { CheckoutCapabilitiesController } from './checkout-capabilities.controller.js';
import type { CheckoutService } from './checkout.service.js';
import type { CheckoutCapabilitiesResponse } from './dto/index.js';

class FakeCheckoutService {
  public calls = 0;

  constructor(private readonly bypassEnabled: boolean) {}

  getCapabilities = (): CheckoutCapabilitiesResponse => {
    this.calls += 1;
    return { paymentBypassEnabled: this.bypassEnabled };
  };
}

function makeController(bypassEnabled: boolean): {
  controller: CheckoutCapabilitiesController;
  svc: FakeCheckoutService;
} {
  const svc = new FakeCheckoutService(bypassEnabled);
  return {
    controller: new CheckoutCapabilitiesController(svc as unknown as CheckoutService),
    svc,
  };
}

describe('CheckoutCapabilitiesController.getCapabilities', () => {
  it('returns paymentBypassEnabled=true when the service reports the bypass on', () => {
    const { controller, svc } = makeController(true);

    const res = controller.getCapabilities();

    expect(res).toEqual({ paymentBypassEnabled: true });
    expect(svc.calls).toBe(1);
  });

  it('returns paymentBypassEnabled=false when the service reports the bypass off', () => {
    const { controller, svc } = makeController(false);

    const res = controller.getCapabilities();

    expect(res).toEqual({ paymentBypassEnabled: false });
    expect(svc.calls).toBe(1);
  });
});
