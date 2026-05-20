/**
 * Snapshot + structural tests for every entry in the template registry.
 *
 * Two layers:
 *   1. Structural — for each template, assert the set of channels it
 *      renders into and the data keys that downstream iOS apps depend on
 *      (templateKey, orderId, etc.). Catches accidental channel removal
 *      and userInfo-key renames in code review.
 *   2. Inline snapshot — pin the full rendered output for one
 *      representative payload per template. Wording changes ripple here
 *      so they get explicit review instead of slipping through silently.
 *
 * Order-related templates use a canonical UUIDv7 prefix so the
 * `formatOrderShort('#01935F3D')` projection is deterministic across runs.
 */
import { describe, expect, it } from 'vitest';
import { renderTemplate, TEMPLATES } from './registry.js';
import type { NotificationTemplateKey } from '../types.js';

const ORDER_ID = '01935f3d-0000-7000-8000-0000000000aa';
const DISPENSARY_ID = '01935f3d-0000-7000-8000-000000000010';
const OFFER_ID = '01935f3d-0000-7000-8000-000000000020';
const PAYOUT_ID = '01935f3d-0000-7000-8000-000000000030';

describe('TEMPLATES registry', () => {
  it('has at least 15 entries per spec §5.1', () => {
    const keys = Object.keys(TEMPLATES) as NotificationTemplateKey[];
    expect(keys.length).toBeGreaterThanOrEqual(15);
  });

  it('produces at least one rendered channel for every key', () => {
    const samples: Readonly<Record<NotificationTemplateKey, () => unknown>> = {
      'order.accepted': () =>
        renderTemplate('order.accepted', { orderId: ORDER_ID, dispensaryName: 'Green Roots' }),
      'order.prepping': () =>
        renderTemplate('order.prepping', { orderId: ORDER_ID, dispensaryName: 'Green Roots' }),
      'order.ready': () =>
        renderTemplate('order.ready', { orderId: ORDER_ID, dispensaryName: 'Green Roots' }),
      'order.picked_up': () =>
        renderTemplate('order.picked_up', { orderId: ORDER_ID, driverFirstName: 'Alex' }),
      'order.arriving': () =>
        renderTemplate('order.arriving', {
          orderId: ORDER_ID,
          driverFirstName: 'Alex',
          etaMinutes: 5,
        }),
      'order.arrived': () =>
        renderTemplate('order.arrived', { orderId: ORDER_ID, driverFirstName: 'Alex' }),
      'order.completed': () =>
        renderTemplate('order.completed', { orderId: ORDER_ID, totalCents: 6_499 }),
      'payment.failed': () =>
        renderTemplate('payment.failed', {
          orderId: ORDER_ID,
          amountCents: 6_499,
          reason: 'card declined',
        }),
      'refund.issued': () =>
        renderTemplate('refund.issued', {
          orderId: ORDER_ID,
          amountCents: 1_999,
          reason: 'item out of stock',
        }),
      'dispensary.new_nearby': () =>
        renderTemplate('dispensary.new_nearby', {
          dispensaryId: DISPENSARY_ID,
          dispensaryName: 'Pine Belt Cannabis',
          distanceMiles: 2.4,
        }),
      'dispatch.offer': () =>
        renderTemplate('dispatch.offer', {
          offerId: OFFER_ID,
          orderId: ORDER_ID,
          dispensaryName: 'Green Roots',
          distanceMiles: 3.1,
          expiresInSeconds: 30,
        }),
      'dispatch.offer_expired': () =>
        renderTemplate('dispatch.offer_expired', { offerId: OFFER_ID, orderId: ORDER_ID }),
      'dispatch.canceled': () =>
        renderTemplate('dispatch.canceled', { orderId: ORDER_ID, reason: 'customer canceled' }),
      'vendor.payout.completed': () =>
        renderTemplate('vendor.payout.completed', {
          payoutId: PAYOUT_ID,
          amountCents: 250_000,
          periodEnd: '2026-05-18',
        }),
      'vendor.metrc.reconciliation_discrepancy': () =>
        renderTemplate('vendor.metrc.reconciliation_discrepancy', {
          dispensaryName: 'Green Roots',
          discrepancyCount: 3,
          kinds: ['quantity_mismatch', 'unrecorded_sale'],
        }),
      'auth.welcome': () => renderTemplate('auth.welcome', { firstName: 'Sam' }),
      'auth.id_verification_required': () =>
        renderTemplate('auth.id_verification_required', { reason: 'document expired' }),
    };
    for (const [key, run] of Object.entries(samples)) {
      const rendered = run() as ReadonlyArray<unknown>;
      expect(rendered.length, `template ${key} returned no channels`).toBeGreaterThan(0);
    }
  });
});

describe('order lifecycle templates', () => {
  it('order.accepted renders push + in_app and omits the ETA when not provided', () => {
    const rendered = renderTemplate('order.accepted', {
      orderId: ORDER_ID,
      dispensaryName: 'Green Roots',
    });
    expect(rendered.map((r) => r.channel)).toEqual(['push', 'in_app']);
    const push = rendered[0];
    if (push?.channel !== 'push') throw new TypeError('expected push');
    expect(push.title).toBe('Order accepted');
    expect(push.body).toBe('Green Roots accepted your order #01935F3D.');
    expect(push.collapseId).toBe(`order-${ORDER_ID}`);
    expect(push.data['orderId']).toBe(ORDER_ID);
  });

  it('order.accepted includes the ETA suffix when etaMinutes is provided', () => {
    const rendered = renderTemplate('order.accepted', {
      orderId: ORDER_ID,
      dispensaryName: 'Green Roots',
      etaMinutes: 12,
    });
    const push = rendered[0];
    if (push?.channel !== 'push') throw new TypeError('expected push');
    expect(push.body).toContain('Estimated ready in 12 minutes');
  });

  it('order.prepping renders push + in_app with the dispensary name', () => {
    const rendered = renderTemplate('order.prepping', {
      orderId: ORDER_ID,
      dispensaryName: 'Green Roots',
    });
    expect(rendered.map((r) => r.channel)).toEqual(['push', 'in_app']);
    const push = rendered[0];
    if (push?.channel !== 'push') throw new TypeError('expected push');
    expect(push.body).toContain('Green Roots is preparing');
  });

  it('order.ready renders push + in_app waiting-for-driver copy', () => {
    const rendered = renderTemplate('order.ready', {
      orderId: ORDER_ID,
      dispensaryName: 'Green Roots',
    });
    expect(rendered.map((r) => r.channel)).toEqual(['push', 'in_app']);
    const push = rendered[0];
    if (push?.channel !== 'push') throw new TypeError('expected push');
    expect(push.body).toContain('waiting for a driver');
  });

  it('order.picked_up renders push + sms (no in_app) with the driver first name', () => {
    const rendered = renderTemplate('order.picked_up', {
      orderId: ORDER_ID,
      driverFirstName: 'Alex',
    });
    expect(rendered.map((r) => r.channel)).toEqual(['push', 'sms']);
    const sms = rendered[1];
    if (sms?.channel !== 'sms') throw new TypeError('expected sms');
    expect(sms.body).toContain('Alex picked up');
    expect(sms.body).toContain('Reply STOP to opt out');
  });

  it('order.arriving renders push + sms with the ETA in minutes', () => {
    const rendered = renderTemplate('order.arriving', {
      orderId: ORDER_ID,
      driverFirstName: 'Alex',
      etaMinutes: 5,
    });
    const push = rendered[0];
    if (push?.channel !== 'push') throw new TypeError('expected push');
    expect(push.data['etaMinutes']).toBe('5');
    expect(push.collapseId).toBe(`order-${ORDER_ID}`);
    const sms = rendered[1];
    if (sms?.channel !== 'sms') throw new TypeError('expected sms');
    expect(sms.body).toContain('5 minutes away');
  });

  it('order.arrived renders push + sms with "Have your ID ready"', () => {
    const rendered = renderTemplate('order.arrived', {
      orderId: ORDER_ID,
      driverFirstName: 'Alex',
    });
    const push = rendered[0];
    if (push?.channel !== 'push') throw new TypeError('expected push');
    expect(push.body).toContain('Have your ID ready');
    const sms = rendered[1];
    if (sms?.channel !== 'sms') throw new TypeError('expected sms');
    expect(sms.body).toContain('Please have your ID ready');
  });

  it('order.completed renders push + in_app + email with the order total', () => {
    const rendered = renderTemplate('order.completed', {
      orderId: ORDER_ID,
      totalCents: 6_499,
    });
    expect(rendered.map((r) => r.channel)).toEqual(['push', 'in_app', 'email']);
    const email = rendered[2];
    if (email?.channel !== 'email') throw new TypeError('expected email');
    expect(email.subject).toContain('#01935F3D');
    expect(email.text).toContain('$64.99');
  });

  it('payment.failed renders push + email with the amount and reason', () => {
    const rendered = renderTemplate('payment.failed', {
      orderId: ORDER_ID,
      amountCents: 6_499,
      reason: 'Card declined.',
    });
    expect(rendered.map((r) => r.channel)).toEqual(['push', 'email']);
    const email = rendered[1];
    if (email?.channel !== 'email') throw new TypeError('expected email');
    expect(email.text).toContain('Card declined.');
    expect(email.text).toContain('$64.99');
  });

  it('refund.issued renders push + email with the refund amount and reason', () => {
    const rendered = renderTemplate('refund.issued', {
      orderId: ORDER_ID,
      amountCents: 1_999,
      reason: 'Item out of stock.',
    });
    expect(rendered.map((r) => r.channel)).toEqual(['push', 'email']);
    const email = rendered[1];
    if (email?.channel !== 'email') throw new TypeError('expected email');
    expect(email.text).toContain('Item out of stock.');
    expect(email.text).toContain('$19.99');
  });
});

describe('dispensary template', () => {
  it('dispensary.new_nearby renders push + in_app with the distance', () => {
    const rendered = renderTemplate('dispensary.new_nearby', {
      dispensaryId: DISPENSARY_ID,
      dispensaryName: 'Pine Belt Cannabis',
      distanceMiles: 2.4,
    });
    expect(rendered.map((r) => r.channel)).toEqual(['push', 'in_app']);
    const push = rendered[0];
    if (push?.channel !== 'push') throw new TypeError('expected push');
    expect(push.body).toContain('2.4 mi away');
    expect(push.data['dispensaryId']).toBe(DISPENSARY_ID);
  });
});

describe('dispatch templates', () => {
  it('dispatch.offer renders push-only with the distance, dispensary, and expiry', () => {
    const rendered = renderTemplate('dispatch.offer', {
      offerId: OFFER_ID,
      orderId: ORDER_ID,
      dispensaryName: 'Green Roots',
      distanceMiles: 3.1,
      expiresInSeconds: 30,
    });
    expect(rendered.map((r) => r.channel)).toEqual(['push']);
    const push = rendered[0];
    if (push?.channel !== 'push') throw new TypeError('expected push');
    expect(push.body).toBe('Green Roots • 3.1 mi • respond in 1 minute');
    expect(push.collapseId).toBe(`offer-${ORDER_ID}`);
    expect(push.contentAvailable).toBe(false);
    expect(push.data['offerId']).toBe(OFFER_ID);
  });

  it('dispatch.offer_expired renders a silent (contentAvailable=true) push', () => {
    const rendered = renderTemplate('dispatch.offer_expired', {
      offerId: OFFER_ID,
      orderId: ORDER_ID,
    });
    const push = rendered[0];
    if (push?.channel !== 'push') throw new TypeError('expected push');
    expect(push.contentAvailable).toBe(true);
    expect(push.body).toContain('#01935F3D');
  });

  it('dispatch.canceled renders push with the cancellation reason', () => {
    const rendered = renderTemplate('dispatch.canceled', {
      orderId: ORDER_ID,
      reason: 'customer canceled',
    });
    const push = rendered[0];
    if (push?.channel !== 'push') throw new TypeError('expected push');
    expect(push.body).toContain('customer canceled');
  });
});

describe('vendor templates', () => {
  it('vendor.payout.completed renders email-only with the amount and period', () => {
    const rendered = renderTemplate('vendor.payout.completed', {
      payoutId: PAYOUT_ID,
      amountCents: 250_000,
      periodEnd: '2026-05-18',
    });
    expect(rendered.map((r) => r.channel)).toEqual(['email']);
    const email = rendered[0];
    if (email?.channel !== 'email') throw new TypeError('expected email');
    expect(email.subject).toContain('$2,500.00');
    expect(email.text).toContain('2026-05-18');
    expect(email.text).toContain(PAYOUT_ID);
  });

  it('vendor.metrc.reconciliation_discrepancy renders email with comma-joined kinds', () => {
    const rendered = renderTemplate('vendor.metrc.reconciliation_discrepancy', {
      dispensaryName: 'Green Roots',
      discrepancyCount: 3,
      kinds: ['quantity_mismatch', 'unrecorded_sale'],
    });
    const email = rendered[0];
    if (email?.channel !== 'email') throw new TypeError('expected email');
    expect(email.text).toContain('3 discrepancy');
    expect(email.text).toContain('quantity_mismatch, unrecorded_sale');
  });

  it('vendor.metrc.reconciliation_discrepancy falls back to "unknown" when kinds is empty', () => {
    const rendered = renderTemplate('vendor.metrc.reconciliation_discrepancy', {
      dispensaryName: 'Green Roots',
      discrepancyCount: 1,
      kinds: [],
    });
    const email = rendered[0];
    if (email?.channel !== 'email') throw new TypeError('expected email');
    expect(email.text).toContain('Discrepancy kinds: unknown');
  });
});

describe('auth templates', () => {
  it('auth.welcome renders email + in_app and embeds the first name', () => {
    const rendered = renderTemplate('auth.welcome', { firstName: 'Sam' });
    expect(rendered.map((r) => r.channel)).toEqual(['email', 'in_app']);
    const email = rendered[0];
    if (email?.channel !== 'email') throw new TypeError('expected email');
    expect(email.text).toContain('Hi Sam,');
    const inApp = rendered[1];
    if (inApp?.channel !== 'in_app') throw new TypeError('expected in_app');
    expect(inApp.body).toContain('Hi Sam!');
  });

  it('auth.id_verification_required renders push + email with the reason', () => {
    const rendered = renderTemplate('auth.id_verification_required', {
      reason: 'document expired',
    });
    expect(rendered.map((r) => r.channel)).toEqual(['push', 'email']);
    const push = rendered[0];
    if (push?.channel !== 'push') throw new TypeError('expected push');
    expect(push.body).toContain('document expired');
    const email = rendered[1];
    if (email?.channel !== 'email') throw new TypeError('expected email');
    expect(email.text).toContain('document expired');
  });
});

describe('inline snapshots — wording stability', () => {
  // One canonical snapshot per template family. Wording changes ripple
  // here so they get explicit review.
  it('order.accepted (with eta) renders to a stable shape', () => {
    expect(
      renderTemplate('order.accepted', {
        orderId: ORDER_ID,
        dispensaryName: 'Green Roots',
        etaMinutes: 12,
      }),
    ).toMatchInlineSnapshot(`
      [
        {
          "body": "Green Roots accepted your order #01935F3D. Estimated ready in 12 minutes.",
          "channel": "push",
          "collapseId": "order-01935f3d-0000-7000-8000-0000000000aa",
          "contentAvailable": false,
          "data": {
            "orderId": "01935f3d-0000-7000-8000-0000000000aa",
            "templateKey": "order.accepted",
          },
          "title": "Order accepted",
        },
        {
          "body": "Green Roots accepted your order #01935F3D. Estimated ready in 12 minutes.",
          "channel": "in_app",
          "data": {
            "orderId": "01935f3d-0000-7000-8000-0000000000aa",
            "templateKey": "order.accepted",
          },
          "title": "Order accepted",
        },
      ]
    `);
  });

  it('order.completed renders to a stable shape', () => {
    expect(renderTemplate('order.completed', { orderId: ORDER_ID, totalCents: 6_499 }))
      .toMatchInlineSnapshot(`
      [
        {
          "body": "Order #01935F3D for $64.99 delivered. Thanks for ordering with DankDash!",
          "channel": "push",
          "collapseId": "order-01935f3d-0000-7000-8000-0000000000aa",
          "contentAvailable": false,
          "data": {
            "orderId": "01935f3d-0000-7000-8000-0000000000aa",
            "templateKey": "order.completed",
          },
          "title": "Delivered",
        },
        {
          "body": "Order #01935F3D for $64.99 delivered. Thanks for ordering with DankDash!",
          "channel": "in_app",
          "data": {
            "orderId": "01935f3d-0000-7000-8000-0000000000aa",
            "templateKey": "order.completed",
          },
          "title": "Delivered",
        },
        {
          "channel": "email",
          "subject": "Your DankDash order #01935F3D was delivered",
          "text": "Thanks for your order!

      Your order #01935F3D totaling $64.99 was delivered successfully.

      Your receipt is attached to your account; tap the Orders tab in the app for full details.

      — The DankDash team",
        },
      ]
    `);
  });

  it('dispatch.offer renders to a stable shape', () => {
    expect(
      renderTemplate('dispatch.offer', {
        offerId: OFFER_ID,
        orderId: ORDER_ID,
        dispensaryName: 'Green Roots',
        distanceMiles: 3.1,
        expiresInSeconds: 30,
      }),
    ).toMatchInlineSnapshot(`
      [
        {
          "body": "Green Roots • 3.1 mi • respond in 1 minute",
          "channel": "push",
          "collapseId": "offer-01935f3d-0000-7000-8000-0000000000aa",
          "contentAvailable": false,
          "data": {
            "offerId": "01935f3d-0000-7000-8000-000000000020",
            "orderId": "01935f3d-0000-7000-8000-0000000000aa",
            "templateKey": "dispatch.offer",
          },
          "title": "New delivery offer",
        },
      ]
    `);
  });
});
