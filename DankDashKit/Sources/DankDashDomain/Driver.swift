import Foundation

/// Self-projection of the authenticated driver. Mirrors the
/// `DriverResponseSchema` shape returned by the admin onboarding +
/// patch endpoints and the (planned) driver-self `GET /v1/driver/me`
/// surface.
///
/// The wire payload's NUMERIC `ratingAvg` arrives as a string; we parse
/// to `Decimal` so cannabis-numeric precision is preserved (project's
/// `NUMERIC_STRING` contract — never `Double` for monetary or weight
/// quantities). The two `date`-typed columns (`insuranceExpiresAt`,
/// `backgroundCheckPassedAt`) are calendar dates without time-of-day;
/// stored here as `String` in `yyyy-MM-dd` form to avoid timezone
/// translation surprises (e.g. an Oct-31 California build interpreting
/// a Nov-1 Minnesota expiry as still-fresh).
///
/// Restricted columns (license number hash, raw license number) are
/// intentionally absent — the iOS app has no use for an opaque bytea,
/// and limiting the wire surface narrows the blast radius if a response
/// is intercepted.
public struct Driver: Identifiable, Hashable, Sendable, Codable {
  public let id: UUID
  public let userId: UUID
  public let vehicle: Vehicle
  public let insuranceDocKey: String?
  public let insuranceExpiresAt: String?
  public let backgroundCheckPassedAt: String?
  public let backgroundCheckProviderRef: String?
  public let currentStatus: DriverStatus
  public let lastStatusChangeAt: Date
  public let currentLocation: Coordinate?
  public let currentLocationUpdatedAt: Date?
  public let currentOrderId: UUID?
  public let ratingAvg: Decimal?
  public let ratingCount: Int
  public let totalDeliveries: Int
  public let createdAt: Date
  public let updatedAt: Date

  public init(
    id: UUID,
    userId: UUID,
    vehicle: Vehicle,
    insuranceDocKey: String?,
    insuranceExpiresAt: String?,
    backgroundCheckPassedAt: String?,
    backgroundCheckProviderRef: String?,
    currentStatus: DriverStatus,
    lastStatusChangeAt: Date,
    currentLocation: Coordinate?,
    currentLocationUpdatedAt: Date?,
    currentOrderId: UUID?,
    ratingAvg: Decimal?,
    ratingCount: Int,
    totalDeliveries: Int,
    createdAt: Date,
    updatedAt: Date
  ) {
    self.id = id
    self.userId = userId
    self.vehicle = vehicle
    self.insuranceDocKey = insuranceDocKey
    self.insuranceExpiresAt = insuranceExpiresAt
    self.backgroundCheckPassedAt = backgroundCheckPassedAt
    self.backgroundCheckProviderRef = backgroundCheckProviderRef
    self.currentStatus = currentStatus
    self.lastStatusChangeAt = lastStatusChangeAt
    self.currentLocation = currentLocation
    self.currentLocationUpdatedAt = currentLocationUpdatedAt
    self.currentOrderId = currentOrderId
    self.ratingAvg = ratingAvg
    self.ratingCount = ratingCount
    self.totalDeliveries = totalDeliveries
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }

  /// True when ops has recorded a passing background check. Drivers
  /// cannot transition into `online` until this is true (the backend
  /// enforces; iOS gates the shift toggle for parity).
  public var isBackgroundCheckPassed: Bool {
    guard let value = backgroundCheckPassedAt, !value.isEmpty else { return false }
    return true
  }

  /// True when the driver is currently engaged with an order — the
  /// shift toggle disables itself in this case so an active delivery
  /// can't be interrupted by a mis-tap.
  public var isOnActiveDelivery: Bool {
    currentStatus.isOnActiveDelivery || currentOrderId != nil
  }

  /// User-facing rating ("4.9 (123)"). Returns nil until the first
  /// rating lands so the UI shows the "New driver" placeholder.
  public var ratingDisplay: String? {
    guard let ratingAvg, ratingCount > 0 else { return nil }
    let formatter = NumberFormatter()
    formatter.numberStyle = .decimal
    formatter.minimumFractionDigits = 1
    formatter.maximumFractionDigits = 1
    let rawNumber = NSDecimalNumber(decimal: ratingAvg)
    guard let formatted = formatter.string(from: rawNumber) else { return nil }
    return "\(formatted) (\(ratingCount))"
  }
}
