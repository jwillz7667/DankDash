import Foundation
import DankDashDomain

/// Wire shape returned by /v1/auth/{login,register,refresh} (success
/// branch) and /v1/me. Mirrors UserSummarySchema in
/// apps/api/src/modules/auth/dto/user-summary.dto.ts.
public struct UserSummaryDTO: Codable, Sendable, Equatable {
  public let id: String
  public let email: String
  public let phone: String?
  public let firstName: String?
  public let lastName: String?
  public let role: String
  public let status: String
  public let kycVerified: Bool
  public let mfaEnabled: Bool
  public let createdAt: String

  public init(
    id: String,
    email: String,
    phone: String?,
    firstName: String?,
    lastName: String?,
    role: String,
    status: String,
    kycVerified: Bool,
    mfaEnabled: Bool,
    createdAt: String
  ) {
    self.id = id
    self.email = email
    self.phone = phone
    self.firstName = firstName
    self.lastName = lastName
    self.role = role
    self.status = status
    self.kycVerified = kycVerified
    self.mfaEnabled = mfaEnabled
    self.createdAt = createdAt
  }
}

public extension UserSummaryDTO {
  /// Lossy mapping into the pure domain User. Returns nil when the wire
  /// shape can't be honored — a malformed UUID, malformed email, unknown
  /// enum value, or an unparseable createdAt.
  func toDomain() -> User? {
    guard let parsedID = UUID(uuidString: id) else { return nil }
    guard let parsedEmail = Email(email) else { return nil }
    guard let parsedRole = UserRole(rawValue: role) else { return nil }
    guard let parsedStatus = UserStatus(rawValue: status) else { return nil }
    guard let parsedCreatedAt = Self.parseISO8601(createdAt) else { return nil }
    let parsedPhone: Phone? = phone.flatMap { Phone($0) }
    return User(
      id: parsedID,
      email: parsedEmail,
      phone: parsedPhone,
      firstName: firstName,
      lastName: lastName,
      role: parsedRole,
      status: parsedStatus,
      kycVerified: kycVerified,
      mfaEnabled: mfaEnabled,
      createdAt: parsedCreatedAt
    )
  }

  /// Parses backend-emitted ISO-8601 timestamps. We try the
  /// fractional-second variant first (NestJS / Zod emits microsecond
  /// precision via z.string().datetime()) and fall back to whole-second
  /// for the rare endpoint that strips fractions.
  static func parseISO8601(_ string: String) -> Date? {
    let withFraction = ISO8601DateFormatter()
    withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = withFraction.date(from: string) { return date }
    let whole = ISO8601DateFormatter()
    whole.formatOptions = [.withInternetDateTime]
    return whole.date(from: string)
  }
}
