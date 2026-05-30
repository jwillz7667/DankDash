import Foundation
import DankDashDomain

/// Wire shape for `DriverPublicProfileSchema`. The consumer sees only
/// the bare minimum (display name, masked phone, vehicle silhouette);
/// real PII (license number, raw phone) lives server-side and never
/// crosses this boundary.
public struct DriverPublicProfileDTO: Decodable, Sendable, Equatable {
  public let id: String
  public let displayName: String
  public let avatarKey: String?
  public let vehicleSummary: String?
  public let maskedPhone: String?

  public init(
    id: String,
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
}

public extension DriverPublicProfileDTO {
  /// Lossy projection — returns nil only on a malformed driver id (the
  /// rest of the row is plain strings the UI renders verbatim).
  func toDomain() -> DriverPublicProfile? {
    guard let parsedID = CatalogWire.parseUUID(id) else { return nil }
    return DriverPublicProfile(
      id: parsedID,
      displayName: displayName,
      avatarKey: avatarKey,
      vehicleSummary: vehicleSummary,
      maskedPhone: maskedPhone
    )
  }
}
