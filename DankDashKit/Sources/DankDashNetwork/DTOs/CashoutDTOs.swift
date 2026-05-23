import Foundation
import DankDashDomain

/// Wire DTOs for `POST /v1/driver/cashout`.
///
/// Mirror of the backend `DriverCashoutRequestSchema` /
/// `DriverCashoutResponseSchema`. The request is a single integer-
/// cents field; the response is the freshly-persisted `payouts` row
/// projection.
///
/// `toDomain()` on the response uses a permissive ISO8601 parse with
/// fractional-second fallback so the backend's `z.string().datetime({
/// offset: true })` shape round-trips whether or not the timestamp
/// carries sub-second precision. A malformed timestamp short-circuits
/// to `nil`, which the client maps to `DriverAPIError.malformedPayload`.

public struct DriverCashoutRequestDTO: Encodable, Sendable, Equatable {
  /// Integer cents. The backend rejects zero (positive() validator),
  /// so the iOS UI disables the Confirm CTA when the parsed amount is
  /// 0; this DTO does no additional validation — it's a wire-shape
  /// type.
  public let amountCents: Int

  public init(amountCents: Int) {
    self.amountCents = amountCents
  }
}

public struct DriverCashoutResponseDTO: Decodable, Sendable, Equatable {
  public let id: String
  public let amountCents: Int
  public let status: String
  public let requestedAt: String
  public let aeropayPayoutRef: String?

  public init(
    id: String,
    amountCents: Int,
    status: String,
    requestedAt: String,
    aeropayPayoutRef: String?
  ) {
    self.id = id
    self.amountCents = amountCents
    self.status = status
    self.requestedAt = requestedAt
    self.aeropayPayoutRef = aeropayPayoutRef
  }

  public func toDomain() -> CashoutRequest? {
    guard let id = UUID(uuidString: id) else { return nil }
    guard let status = CashoutStatus(rawValue: status) else { return nil }
    guard let requestedAt = Self.parseISO8601(requestedAt) else { return nil }
    return CashoutRequest(
      id: id,
      amountCents: amountCents,
      status: status,
      requestedAt: requestedAt,
      aeropayPayoutRef: aeropayPayoutRef
    )
  }

  private static func parseISO8601(_ value: String) -> Date? {
    let withFractional = ISO8601DateFormatter()
    withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = withFractional.date(from: value) { return date }
    let standard = ISO8601DateFormatter()
    standard.formatOptions = [.withInternetDateTime]
    return standard.date(from: value)
  }
}
