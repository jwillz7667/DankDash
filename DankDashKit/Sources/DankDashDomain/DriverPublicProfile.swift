import Foundation

/// Public driver profile attached to an active order's detail response.
/// Mirror of `DriverPublicProfileResponse`. All Restricted fields (raw
/// phone, license hash, insurance docs) stay server-side; the client
/// renders only the bare minimum needed to identify the person at the
/// door.
///
/// `maskedPhone` is the masked E.164 form ("+1 ••• ••• 1234") served
/// straight from the server — iOS does not derive it. The tap-to-call
/// surface routes through Twilio Proxy in Phase 23; Phase 18 dials the
/// raw masked-display number as a placeholder.
///
/// `avatarKey` references the R2 image bucket; absent → render
/// initials. `vehicleSummary` collapses `make / model / year / color`
/// into a single human-readable line ("Blue 2021 Honda Civic"). Plate
/// is intentionally not exposed — the customer doesn't need it to
/// identify a car pulling up out front, and broadcasting it widens the
/// privacy surface.
public struct DriverPublicProfile: Identifiable, Hashable, Sendable, Codable {
  public let id: UUID
  public let displayName: String
  public let avatarKey: String?
  public let vehicleSummary: String?
  public let maskedPhone: String?

  public init(
    id: UUID,
    displayName: String,
    avatarKey: String?,
    vehicleSummary: String?,
    maskedPhone: String?
  ) {
    self.id = id
    self.displayName = displayName
    self.avatarKey = avatarKey
    self.vehicleSummary = vehicleSummary
    self.maskedPhone = maskedPhone
  }

  /// One- or two-letter initials fallback for when `avatarKey` is nil.
  /// Picks the first letter of the first and last whitespace-separated
  /// token of `displayName`; single-token names return one letter.
  /// Empty string for the (defensive) empty-name case.
  public var initials: String {
    let tokens = displayName.split(whereSeparator: { $0.isWhitespace })
    guard let first = tokens.first?.first else { return "" }
    if tokens.count > 1, let last = tokens.last?.first {
      return "\(first)\(last)".uppercased()
    }
    return String(first).uppercased()
  }
}
