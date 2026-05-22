import Foundation

/// Computed-from-``Driver`` view of where the driver stands in the
/// background-check pipeline. The DB schema doesn't have a dedicated
/// enum column — ops sets `backgroundCheckPassedAt` once the
/// third-party provider returns a pass, and `backgroundCheckProviderRef`
/// once the provider session is created.
///
/// The iOS driver onboarding "pending review" screen reads this enum
/// to decide which copy to show.
public enum BackgroundCheckStatus: Hashable, Sendable, Codable, CaseIterable {
  /// No background check has been initiated yet. The user has submitted
  /// onboarding but the provider session hasn't been opened.
  case notStarted
  /// Provider session exists (`backgroundCheckProviderRef != nil`) but
  /// the result hasn't been recorded.
  case inReview
  /// `backgroundCheckPassedAt` is set — the driver is cleared to take
  /// shifts.
  case passed

  /// User-facing label rendered by ``BackgroundCheckStatusBadge``.
  public var displayLabel: String {
    switch self {
    case .notStarted: "Not started"
    case .inReview: "In review"
    case .passed: "Passed"
    }
  }

  /// Derives the status from the driver projection. Returns `.passed`
  /// the moment `backgroundCheckPassedAt` lands, regardless of provider
  /// ref — once a clearance is recorded the provider session is no
  /// longer load-bearing.
  public static func from(driver: Driver) -> BackgroundCheckStatus {
    if driver.isBackgroundCheckPassed { return .passed }
    if let ref = driver.backgroundCheckProviderRef, !ref.isEmpty { return .inReview }
    return .notStarted
  }
}
