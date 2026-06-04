import Foundation

/// The three earnings buckets the backend exposes. Mirrors
/// `EarningsPeriodSchema` from `apps/api/.../drivers/app/dto/driver-app.dto.ts`.
///
/// The backend computes window bounds in `America/Chicago` (local
/// calendar day / Monday-start ISO week / 1st-of-month). The client
/// never re-derives the window; it just renders the server-supplied
/// `since`/`until` pair from ``DriverEarnings``.
public enum EarningsPeriod: String, Hashable, Sendable, CaseIterable, Codable {
  case today
  case week
  case month

  /// Segmented-control / picker label.
  public var displayLabel: String {
    switch self {
    case .today: "Today"
    case .week: "This week"
    case .month: "This month"
    }
  }

  /// Stable query-string value (matches the server's `?period=` enum).
  public var queryValue: String {
    rawValue
  }
}
