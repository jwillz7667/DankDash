import Foundation

/// Bucketed earnings response from `GET /v1/driver/earnings`. Mirrors
/// `EarningsResponseSchema` in
/// `apps/api/.../drivers/app/dto/driver-app.dto.ts`.
///
/// All money fields are integer cents (project rule — `NUMERIC(12,2)`
/// in the DB, integer cents in code). `deliveriesCount` is the count
/// of completed deliveries within the window.
///
/// `since`/`until` is a half-open window the server computes against
/// `America/Chicago`; the client renders it verbatim so e.g. a Sunday
/// reading of "this week" lights up the previous Mon–Sun window even
/// if the device clock is UTC.
public struct DriverEarnings: Hashable, Sendable, Codable {
  public let period: EarningsPeriod
  public let since: Date
  public let until: Date
  public let tipsCents: Int
  public let deliveryFeesCents: Int
  public let deliveriesCount: Int
  public let totalCents: Int

  public init(
    period: EarningsPeriod,
    since: Date,
    until: Date,
    tipsCents: Int,
    deliveryFeesCents: Int,
    deliveriesCount: Int,
    totalCents: Int
  ) {
    self.period = period
    self.since = since
    self.until = until
    self.tipsCents = tipsCents
    self.deliveryFeesCents = deliveryFeesCents
    self.deliveriesCount = deliveriesCount
    self.totalCents = totalCents
  }

  /// Average per-delivery payout. Returns nil for empty windows so the
  /// UI shows the "—" placeholder rather than "$0.00".
  public var averagePerDeliveryCents: Int? {
    guard deliveriesCount > 0 else { return nil }
    return totalCents / deliveriesCount
  }
}
