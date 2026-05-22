import Foundation

/// One dispatch offer presented to a driver. Mirrors the
/// `DispatchOfferResponseSchema` shape returned by the offer
/// accept/decline endpoints in `apps/api/.../drivers/offers/`.
///
/// Phase 19 wires the value type + DTO mapper now so the realtime
/// `/driver` namespace decoder lands in this module unchanged when
/// Phase 20 lights up the offer card UI. The shift home reducer does
/// not subscribe to the offer stream in Phase 19.
///
/// `distanceMiles` is a NUMERIC string on the wire, parsed to
/// `Decimal` per the project's `NUMERIC_STRING` contract. Payout is
/// integer cents.
public struct DispatchOffer: Identifiable, Hashable, Sendable, Codable {
  public let id: UUID
  public let orderId: UUID
  public let driverId: UUID
  public let offeredAt: Date
  public let expiresAt: Date
  public let payoutEstimateCents: Int
  public let distanceMiles: Decimal
  public let status: Status
  public let respondedAt: Date?
  public let declineReason: String?

  public init(
    id: UUID,
    orderId: UUID,
    driverId: UUID,
    offeredAt: Date,
    expiresAt: Date,
    payoutEstimateCents: Int,
    distanceMiles: Decimal,
    status: Status,
    respondedAt: Date?,
    declineReason: String?
  ) {
    self.id = id
    self.orderId = orderId
    self.driverId = driverId
    self.offeredAt = offeredAt
    self.expiresAt = expiresAt
    self.payoutEstimateCents = payoutEstimateCents
    self.distanceMiles = distanceMiles
    self.status = status
    self.respondedAt = respondedAt
    self.declineReason = declineReason
  }

  /// True when the offer is past its acceptance window. The Phase 20
  /// offer card uses this to gray out and auto-dismiss expired offers
  /// without round-tripping through the server.
  public func isExpired(referenceDate: Date = Date()) -> Bool {
    referenceDate >= expiresAt
  }

  /// Seconds remaining on the acceptance window. Returns zero past
  /// expiry so the offer-card timer doesn't go negative.
  public func secondsRemaining(referenceDate: Date = Date()) -> TimeInterval {
    max(0, expiresAt.timeIntervalSince(referenceDate))
  }

  public enum Status: String, Hashable, Sendable, CaseIterable, Codable {
    case offered
    case accepted
    case declined
    case expired
  }
}
