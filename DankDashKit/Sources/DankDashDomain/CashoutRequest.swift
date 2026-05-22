import Foundation

/// A single driver-initiated cashout request. Mirror of the
/// `POST /v1/driver/cashout` response (Phase 20) — one row in the
/// driver's `payouts` ledger.
///
/// Phase 20 ships the persistence + balance-gate path; the upstream
/// Aeropay push is flag-gated behind `AEROPAY_LIVE` and stubbed when
/// off, so a freshly-created cashout lands in ``CashoutStatus/pending``
/// with `aeropayPayoutRef == nil`. Ops processes manually until the
/// live integration lands.
public struct CashoutRequest: Sendable, Equatable, Hashable, Identifiable, Codable {
  public let id: UUID
  public let amountCents: Int
  public let status: CashoutStatus
  public let requestedAt: Date
  /// Upstream Aeropay payout reference once the live client lights up;
  /// `nil` while the integration is stubbed. The driver UI never shows
  /// this — it's wire-only so ops dashboards can correlate against the
  /// Aeropay portal.
  public let aeropayPayoutRef: String?

  public init(
    id: UUID,
    amountCents: Int,
    status: CashoutStatus,
    requestedAt: Date,
    aeropayPayoutRef: String?
  ) {
    self.id = id
    self.amountCents = amountCents
    self.status = status
    self.requestedAt = requestedAt
    self.aeropayPayoutRef = aeropayPayoutRef
  }
}

/// Lifecycle of a single cashout row. Mirror of the backend
/// `CashoutStatusSchema` — a subset of the broader `payouts.status`
/// enum, scoped to the states a driver-initiated cashout ever passes
/// through.
public enum CashoutStatus: String, Sendable, Equatable, Hashable, Codable, CaseIterable {
  case pending
  case processing
  case completed
  case failed
  case canceled

  public var displayLabel: String {
    switch self {
    case .pending: "Pending"
    case .processing: "Processing"
    case .completed: "Completed"
    case .failed: "Failed"
    case .canceled: "Canceled"
    }
  }
}
