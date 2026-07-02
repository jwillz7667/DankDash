/**
 * RefundNotificationsListener test — pins that a RefundIssuedEvent maps to
 * a consumer `refund.issued` dispatch addressed to the order owner, keyed
 * by refundId for idempotency, and that the listener never throws.
 */
import { describe, expect, it } from 'vitest';
import { RefundIssuedEvent } from '../payments/refund-issued.events.js';
import {
  type DispatchInput,
  type DispatchOutcome,
  type NotificationDispatcher,
} from './notification-dispatcher.service.js';
import { RefundNotificationsListener } from './refund-notifications.listener.js';
import type { NotificationTemplateKey } from '@dankdash/notifications';

const ORDER_ID = '01935f3d-0000-7000-8000-0000000000aa';
const USER_ID = '01935f3d-0000-7000-8000-000000000001';
const REFUND_ID = '01935f3d-0000-7000-8000-000000000040';

class FakeDispatcher {
  calls: Array<DispatchInput<NotificationTemplateKey>> = [];
  shouldThrow = false;

  dispatch = <TKey extends NotificationTemplateKey>(
    input: DispatchInput<TKey>,
  ): Promise<DispatchOutcome> => {
    if (this.shouldThrow) throw new TypeError('boom');
    this.calls.push(input);
    return Promise.resolve({ skipped: false, results: [] });
  };
}

function buildEvent(): RefundIssuedEvent {
  return new RefundIssuedEvent({
    refundId: REFUND_ID,
    orderId: ORDER_ID,
    userId: USER_ID,
    amountCents: 1_999,
    reason: 'Item out of stock.',
  });
}

function buildListener(dispatcher: FakeDispatcher): RefundNotificationsListener {
  return new RefundNotificationsListener({
    dispatcher: dispatcher as unknown as NotificationDispatcher,
  });
}

describe('RefundNotificationsListener', () => {
  it('dispatches refund.issued to the order owner keyed by refundId', async () => {
    const dispatcher = new FakeDispatcher();

    await buildListener(dispatcher).onRefundIssued(buildEvent());

    expect(dispatcher.calls).toEqual([
      {
        userId: USER_ID,
        templateKey: 'refund.issued',
        payload: { orderId: ORDER_ID, amountCents: 1_999, reason: 'Item out of stock.' },
        appVariant: 'consumer',
        idempotencyKey: REFUND_ID,
      },
    ]);
  });

  it('swallows dispatcher errors so the emit path is never affected', async () => {
    const dispatcher = new FakeDispatcher();
    dispatcher.shouldThrow = true;

    await expect(buildListener(dispatcher).onRefundIssued(buildEvent())).resolves.toBeUndefined();
  });
});
