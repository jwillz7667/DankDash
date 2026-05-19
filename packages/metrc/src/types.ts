/**
 * Public types for the Metrc adapter.
 *
 * Metrc's REST API uses PascalCase JSON keys; the client normalizes to
 * camelCase at the boundary so consumers never see the upstream casing.
 * Money is expressed as integer cents on the input side (consistent with
 * the rest of the codebase) and converted to the major-units number that
 * Metrc expects (`TotalAmount: 9.99`) inside `client.ts`.
 *
 * Cannabis weight values flow through as `decimal.js`-friendly strings on
 * the input side — the adapter never coerces them to JS `number`, which
 * would round 0.1g + 0.2g to 0.30000000000000004g and tear holes in the
 * per-transaction limit enforcement upstream.
 */

/**
 * Metrc unit of measure for a transaction line. Mirrors the upstream
 * enum exactly — keeping the strings verbatim avoids a translation table
 * and means the JSON we POST is the same as what Metrc serializes back
 * to us in the active-receipts endpoint.
 */
export type MetrcUnitOfMeasure =
  | 'Grams'
  | 'Ounces'
  | 'Pounds'
  | 'Milligrams'
  | 'Kilograms'
  | 'Each';

/**
 * Customer classification for the sale. Recreational deliveries are
 * `Consumer`. Medical patient flow (out-of-scope today but the enum
 * supports it) would be `Patient`.
 */
export type MetrcSalesCustomerType = 'Consumer' | 'Patient' | 'Caregiver' | 'ExternalPatient';

export interface MetrcTransactionLine {
  /** Metrc package tag (e.g. `1A4FF01000000220000123`). */
  readonly packageLabel: string;
  /** Numeric quantity sold from the package. Pass as a string to preserve precision. */
  readonly quantity: string;
  readonly unitOfMeasure: MetrcUnitOfMeasure;
  /** Customer-facing line total in integer cents — the client converts to dollars. */
  readonly totalAmountCents: number;
}

export interface CreateReceiptInput {
  /**
   * UTC instant the sale was finalized (we use the order's `delivered_at`).
   * Metrc expects an ISO-8601 datetime in the receipt payload.
   */
  readonly salesDateTime: Date;
  readonly salesCustomerType: MetrcSalesCustomerType;
  readonly transactions: ReadonlyArray<MetrcTransactionLine>;
  /**
   * Optional patient license — only set when `salesCustomerType` is
   * `Patient` or `Caregiver`. Recreational sales leave this undefined.
   */
  readonly patientLicenseNumber?: string;
  /** Required by Metrc but per-facility — passed at call site. */
  readonly licenseNumber: string;
  /** Per-facility Metrc user API key, decrypted at call site. */
  readonly userKey: string;
}

export interface MetrcReceipt {
  /** Upstream-assigned receipt ID; surfaced via `/receipts/active` lookups. */
  readonly id: number;
  readonly receiptNumber: string;
  readonly salesDateTime: Date;
  readonly salesCustomerType: MetrcSalesCustomerType;
  readonly totalPackages: number;
  readonly totalPrice: string;
  readonly transactions: ReadonlyArray<MetrcReceiptTransaction>;
  readonly lastModified: Date;
}

export interface MetrcReceiptTransaction {
  readonly packageId: number;
  readonly packageLabel: string;
  readonly productName: string;
  readonly quantity: string;
  readonly unitOfMeasure: MetrcUnitOfMeasure;
  readonly totalPrice: string;
}

export interface ListActiveReceiptsInput {
  /** Inclusive lower bound on `LastModified` (UTC). */
  readonly lastModifiedStart: Date;
  /** Exclusive upper bound on `LastModified` (UTC). */
  readonly lastModifiedEnd: Date;
  readonly licenseNumber: string;
  readonly userKey: string;
}

export interface GetReceiptInput {
  readonly id: number;
  readonly licenseNumber: string;
  readonly userKey: string;
}

/**
 * Outcome of a successful create. Metrc's POST endpoints return 200 with
 * an empty body on success and never include the freshly minted receipt
 * ID — the canonical way to discover it is a subsequent
 * `/receipts/active` query bounded by the sale's timestamp window.
 *
 * We surface the `acceptedAt` clock so callers can record when the
 * upstream acknowledged the post; reconciliation joins on that.
 */
export interface CreateReceiptOutcome {
  readonly acceptedAt: Date;
}
