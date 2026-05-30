import Foundation
import DankDashDomain

/// Wire shape of `dispatch_offers`. Mirrors the Phase-8
/// `DispatchOfferResponseSchema`. `distanceMiles` flows as a
/// `NUMERIC_STRING` per the cannabis-numeric contract; a malformed
/// value fails the projection rather than silently round-tripping to
/// zero. `respondedAt` is null on `offered` rows and populated on
/// `accepted` / `declined` / `expired` rows.
public struct DispatchOfferResponseDTO: Decodable, Sendable, Equatable {
  public let id: String
  public let orderId: String
  public let driverId: String
  public let offeredAt: String
  public let expiresAt: String
  public let payoutEstimateCents: Int
  public let distanceMiles: String
  public let status: String
  public let respondedAt: String?
  public let declineReason: String?

  public init(
    id: String,
    orderId: String,
    driverId: String,
    offeredAt: String,
    expiresAt: String,
    payoutEstimateCents: Int,
    distanceMiles: String,
    status: String,
    respondedAt: String?,
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
}

public extension DispatchOfferResponseDTO {
  /// Lossy projection. Returns nil for any malformed scalar — offers
  /// are the inputs to a 30-second countdown UI, so a partially
  /// decoded offer card would be actively harmful.
  func toDomain() -> DispatchOffer? {
    guard let parsedID = CatalogWire.parseUUID(id) else { return nil }
    guard let parsedOrderID = CatalogWire.parseUUID(orderId) else { return nil }
    guard let parsedDriverID = CatalogWire.parseUUID(driverId) else { return nil }
    guard let parsedOfferedAt = CatalogWire.parseISO8601(offeredAt) else { return nil }
    guard let parsedExpiresAt = CatalogWire.parseISO8601(expiresAt) else { return nil }
    guard let parsedDistance = CatalogWire.parseDecimal(distanceMiles) else { return nil }
    guard let parsedStatus = DispatchOffer.Status(rawValue: status) else { return nil }

    let parsedRespondedAt: Date?
    if let respondedAt {
      guard let resolved = CatalogWire.parseISO8601(respondedAt) else { return nil }
      parsedRespondedAt = resolved
    } else {
      parsedRespondedAt = nil
    }

    return DispatchOffer(
      id: parsedID,
      orderId: parsedOrderID,
      driverId: parsedDriverID,
      offeredAt: parsedOfferedAt,
      expiresAt: parsedExpiresAt,
      payoutEstimateCents: payoutEstimateCents,
      distanceMiles: parsedDistance,
      status: parsedStatus,
      respondedAt: parsedRespondedAt,
      declineReason: declineReason
    )
  }
}

/// Body for `POST /v1/driver/offers/:id/decline`. Optional human
/// `reason` written to `dispatch_offers.decline_reason` — capped at
/// 280 chars server-side. iOS keeps the field optional so the
/// "decline silently" sheet button sends `nil`.
public struct DeclineOfferRequestDTO: Encodable, Sendable, Equatable {
  public let reason: String?

  public init(reason: String?) {
    let trimmed = reason?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let trimmed, !trimmed.isEmpty {
      self.reason = String(trimmed.prefix(280))
    } else {
      self.reason = nil
    }
  }

  private enum CodingKeys: String, CodingKey { case reason }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    if let reason {
      try container.encode(reason, forKey: .reason)
    }
  }
}
