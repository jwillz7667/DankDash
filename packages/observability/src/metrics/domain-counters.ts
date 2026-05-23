/**
 * Business-domain counters surfaced on Grafana KPI dashboards.
 *
 * These are not technical metrics (latency, errors) — they are
 * product signals: orders placed, orders delivered, payouts
 * processed, ID-scan outcomes. The KPI dashboard reads these
 * directly and the on-call alerts on negative deltas (e.g. orders
 * placed drops to zero for ≥10 min during peak hours).
 *
 * The `result` label keeps cardinality bounded (a single enum per
 * counter); the dispensary id is **not** a label here because that
 * would blow up cardinality once we scale past ~50 dispensaries.
 * Per-dispensary breakdowns live in the OTel traces instead.
 */
import { Counter, type Registry } from 'prom-client';

export interface DomainCounters {
  readonly ordersPlaced: Counter<'dispensary_state'>;
  readonly ordersDelivered: Counter<'outcome'>;
  readonly payoutsProcessed: Counter<'outcome'>;
  readonly idScanCompleted: Counter<'outcome'>;
  readonly cartValidationFailed: Counter<'reason'>;
  readonly complianceCheckBlocked: Counter<'reason'>;
}

export function createDomainCounters(registry: Registry): DomainCounters {
  const ordersPlaced = new Counter({
    name: 'orders_placed_total',
    help: 'Total orders that successfully transitioned from cart to placed.',
    labelNames: ['dispensary_state'],
    registers: [registry],
  });
  const ordersDelivered = new Counter({
    name: 'orders_delivered_total',
    help: 'Total orders that reached the delivered state. Outcome breaks out delivered vs cancelled-after-pickup.',
    labelNames: ['outcome'],
    registers: [registry],
  });
  const payoutsProcessed = new Counter({
    name: 'payouts_processed_total',
    help: 'Payout cycles that completed. Outcome breaks out success vs partial-failure.',
    labelNames: ['outcome'],
    registers: [registry],
  });
  const idScanCompleted = new Counter({
    name: 'id_scan_completed_total',
    help: 'Veriff sessions whose webhook reached a terminal decision. Outcome = approved | declined | resubmission | expired.',
    labelNames: ['outcome'],
    registers: [registry],
  });
  const cartValidationFailed = new Counter({
    name: 'cart_validation_failed_total',
    help: 'Cart validation failures. Reason breaks out compliance rule code (e.g. THC_LIMIT_EXCEEDED).',
    labelNames: ['reason'],
    registers: [registry],
  });
  const complianceCheckBlocked = new Counter({
    name: 'compliance_check_blocked_total',
    help: 'Compliance engine block events at any gate (cart, checkout, delivery). Reason = rule code.',
    labelNames: ['reason'],
    registers: [registry],
  });

  return {
    ordersPlaced,
    ordersDelivered,
    payoutsProcessed,
    idScanCompleted,
    cartValidationFailed,
    complianceCheckBlocked,
  };
}
