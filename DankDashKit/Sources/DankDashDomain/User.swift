import Foundation

/// The seven roles the backend supports — matches `UserRoleSchema` in
/// `apps/api/.../auth/dto/user-summary.dto.ts`. `.customer` is the only
/// role the consumer iOS app should encounter at the auth boundary;
/// the rest are present so the same DTO decodes correctly when the
/// backend hands us a session for staff debugging or driver-app reuse.
public enum UserRole: String, Codable, Hashable, Sendable, CaseIterable {
  case customer
  case budtender
  case manager
  case owner
  case driver
  case admin
  case superadmin
}

public enum UserStatus: String, Codable, Hashable, Sendable, CaseIterable {
  case pendingKyc = "pending_kyc"
  case active
  case suspended
  case banned
}

/// The minimal user shape we hold post-auth. Mirrors `UserSummarySchema`
/// on the backend — restricted columns (mfa secret, password hash, raw
/// DOB, kyc provider refs) are intentionally absent.
public struct User: Hashable, Sendable {
  public let id: UUID
  public let email: Email
  public let phone: Phone?
  public let firstName: String?
  public let lastName: String?
  public let role: UserRole
  public let status: UserStatus
  public let kycVerified: Bool
  public let mfaEnabled: Bool
  public let createdAt: Date

  public init(
    id: UUID,
    email: Email,
    phone: Phone?,
    firstName: String?,
    lastName: String?,
    role: UserRole,
    status: UserStatus,
    kycVerified: Bool,
    mfaEnabled: Bool,
    createdAt: Date
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

  /// The first/last name fields are nullable on the wire (a customer can
  /// register through KYC-only flow). `displayName` is the safe rendering
  /// to put on the post-auth UI without a follow-up /me call.
  public var displayName: String {
    let trimmedFirst = (firstName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedLast = (lastName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let joined = [trimmedFirst, trimmedLast].filter { !$0.isEmpty }.joined(separator: " ")
    if !joined.isEmpty { return joined }
    return email.rawValue
  }
}
