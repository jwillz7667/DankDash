import { formatUsdCents } from './format.js';
import type { Template } from './template.js';

/**
 * New-order alert for dispensary staff. The vendor portal is web-only
 * (no APNs variant — see `push-token.dto.ts`), so this renders email +
 * in_app rather than push: email is the reach-when-the-tab-is-closed
 * channel, and the in_app row is the durable per-staff record the portal
 * surfaces. The realtime `order:created` socket event already lights up
 * the live queue for an open tab; this template covers the staff who
 * aren't looking.
 */
export const vendorNewOrderTemplate: Template<'vendor.new_order'> = (payload) => {
  const amount = formatUsdCents(payload.totalCents);
  const subject = `New order ${payload.shortCode} — ${amount}`;
  const body = `You have a new ${amount} order (${payload.shortCode}) at ${payload.dispensaryName}. Open the vendor portal to accept it before it times out.`;
  const text = `Hi,\n\nA new order just came in for ${payload.dispensaryName}.\n\nOrder: ${payload.shortCode}\nTotal: ${amount}\n\nOpen the vendor portal → Orders to accept it. Orders that aren't accepted promptly are surfaced to the customer as delayed, so please review it soon.\n\n— DankDash`;
  return [
    {
      channel: 'email',
      subject,
      text,
    },
    {
      channel: 'in_app',
      title: 'New order',
      body,
      data: {
        templateKey: 'vendor.new_order',
        orderId: payload.orderId,
        shortCode: payload.shortCode,
      },
    },
  ];
};

export const vendorPayoutCompletedTemplate: Template<'vendor.payout.completed'> = (payload) => {
  const amount = formatUsdCents(payload.amountCents);
  const subject = `Payout of ${amount} sent for period ending ${payload.periodEnd}`;
  const text = `Hi,\n\nWe just sent a ${amount} payout to your bank account for the period ending ${payload.periodEnd}.\n\nFunds typically arrive within 1–2 business days. Your full payout report is available in the vendor portal under Finance → Payouts (reference: ${payload.payoutId}).\n\n— DankDash Finance`;
  return [
    {
      channel: 'email',
      subject,
      text,
    },
  ];
};

export const vendorMetrcReconciliationDiscrepancyTemplate: Template<
  'vendor.metrc.reconciliation_discrepancy'
> = (payload) => {
  const kindsList = payload.kinds.length > 0 ? payload.kinds.join(', ') : 'unknown';
  const subject = `Action needed: Metrc reconciliation discrepancies for ${payload.dispensaryName}`;
  const text = `Tonight's Metrc reconciliation run flagged ${payload.discrepancyCount} discrepancy(s) for ${payload.dispensaryName}.\n\nDiscrepancy kinds: ${kindsList}.\n\nPlease open the vendor portal → Compliance → Metrc Reconciliation to review and resolve. Unresolved discrepancies can result in audit findings — please address within 24 hours.\n\n— DankDash Compliance`;
  return [
    {
      channel: 'email',
      subject,
      text,
    },
  ];
};
