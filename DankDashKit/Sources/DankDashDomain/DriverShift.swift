import Foundation

/// One shift on the driver's history. Mirrors `DriverShiftResponseSchema`
/// from `apps/api/.../drivers/shift/dto/shift.dto.ts`.
///
/// `totalMiles` is a NUMERIC string on the wire — parsed via the
/// project's `NUMERIC_STRING` contract into `Decimal`. `totalEarningsCents`
/// is integer cents (project rule — never `Double` for money).
///
/// `endedAt == nil` means this shift is still open; the driver app's
/// session store seeds `activeShift` from the response of
/// `POST /v1/driver/shift/start` and clears it on the response of
/// `POST /v1/driver/shift/end`.
public struct DriverShift: Identifiable, Hashable, Sendable, Codable {
  public let id: UUID
  public let driverId: UUID
  public let startedAt: Date
  public let endedAt: Date?
  public let startingLocation: Coordinate?
  public let endingLocation: Coordinate?
  public let totalMiles: Decimal?
  public let totalDeliveries: Int
  public let totalEarningsCents: Int

  public init(
    id: UUID,
    driverId: UUID,
    startedAt: Date,
    endedAt: Date?,
    startingLocation: Coordinate?,
    endingLocation: Coordinate?,
    totalMiles: Decimal?,
    totalDeliveries: Int,
    totalEarningsCents: Int
  ) {
    self.id = id
    self.driverId = driverId
    self.startedAt = startedAt
    self.endedAt = endedAt
    self.startingLocation = startingLocation
    self.endingLocation = endingLocation
    self.totalMiles = totalMiles
    self.totalDeliveries = totalDeliveries
    self.totalEarningsCents = totalEarningsCents
  }

  /// True while the shift row is still open. The shift home UI uses
  /// this to render the live "ongoing shift" timer.
  public var isActive: Bool {
    endedAt == nil
  }

  /// Shift duration in whole seconds. Counts up from `startedAt` for an
  /// active shift; closed shifts return the fixed window between
  /// `startedAt` and `endedAt`.
  public func duration(referenceDate: Date = Date()) -> TimeInterval {
    let end = endedAt ?? referenceDate
    return max(0, end.timeIntervalSince(startedAt))
  }
}
