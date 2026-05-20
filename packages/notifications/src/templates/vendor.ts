import { formatUsdCents } from './format.js';
import type { Template } from './template.js';

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
