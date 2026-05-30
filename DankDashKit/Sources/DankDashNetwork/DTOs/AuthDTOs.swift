import Foundation

/// Mirror of `TokenPairSchema` (apps/api/.../auth/dto/tokens.dto.ts).
/// `accessToken` is the RS256 JWT (15-min TTL). `refreshToken` is the
/// opaque value the server hashes; the iOS client holds it in the
/// biometric-guarded keychain entry.
public struct TokenPairDTO: Codable, Sendable, Equatable {
  public let accessToken: String
  public let refreshToken: String
  public let accessTokenExpiresAt: String
  public let refreshTokenExpiresAt: String
  public let tokenType: String

  public init(
    accessToken: String,
    refreshToken: String,
    accessTokenExpiresAt: String,
    refreshTokenExpiresAt: String,
    tokenType: String = "Bearer"
  ) {
    self.accessToken = accessToken
    self.refreshToken = refreshToken
    self.accessTokenExpiresAt = accessTokenExpiresAt
    self.refreshTokenExpiresAt = refreshTokenExpiresAt
    self.tokenType = tokenType
  }
}

// MARK: - Login

/// POST /v1/auth/login request body. `mfaCode` is the optional second-
/// factor TOTP retried on the same endpoint after a `mfa_required`
/// response.
public struct LoginRequestDTO: Codable, Sendable, Equatable {
  public let email: String
  public let password: String
  public let mfaCode: String?

  public init(email: String, password: String, mfaCode: String? = nil) {
    self.email = email
    self.password = password
    self.mfaCode = mfaCode
  }
}

/// Discriminated union response from /v1/auth/login. The backend sends
/// `status: "authenticated"` with a token pair, or `status: "mfa_required"`
/// with an opaque challenge identifier the client must echo back on the
/// follow-up call.
public enum LoginResponseDTO: Sendable, Equatable {
  case authenticated(user: UserSummaryDTO, tokens: TokenPairDTO)
  case mfaRequired(challengeId: String, challengeExpiresAt: String)
}

extension LoginResponseDTO: Decodable {
  private enum CodingKeys: String, CodingKey {
    case status
    case user
    case tokens
    case challengeId
    case challengeExpiresAt
  }

  private enum Status: String, Decodable {
    case authenticated
    case mfaRequired = "mfa_required"
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let status = try container.decode(Status.self, forKey: .status)
    switch status {
    case .authenticated:
      let user = try container.decode(UserSummaryDTO.self, forKey: .user)
      let tokens = try container.decode(TokenPairDTO.self, forKey: .tokens)
      self = .authenticated(user: user, tokens: tokens)
    case .mfaRequired:
      let challengeId = try container.decode(String.self, forKey: .challengeId)
      let challengeExpiresAt = try container.decode(String.self, forKey: .challengeExpiresAt)
      self = .mfaRequired(challengeId: challengeId, challengeExpiresAt: challengeExpiresAt)
    }
  }
}

// MARK: - Register

public struct RegisterRequestDTO: Codable, Sendable, Equatable {
  public let email: String
  public let password: String
  public let phone: String?
  public let dateOfBirth: String
  public let firstName: String
  public let lastName: String

  public init(
    email: String,
    password: String,
    phone: String? = nil,
    dateOfBirth: String,
    firstName: String,
    lastName: String
  ) {
    self.email = email
    self.password = password
    self.phone = phone
    self.dateOfBirth = dateOfBirth
    self.firstName = firstName
    self.lastName = lastName
  }
}

public struct RegisterResponseDTO: Decodable, Sendable, Equatable {
  public let user: UserSummaryDTO
  public let tokens: TokenPairDTO

  public init(user: UserSummaryDTO, tokens: TokenPairDTO) {
    self.user = user
    self.tokens = tokens
  }
}

// MARK: - Refresh

public struct RefreshRequestDTO: Codable, Sendable, Equatable {
  public let refreshToken: String

  public init(refreshToken: String) {
    self.refreshToken = refreshToken
  }
}

public struct RefreshResponseDTO: Decodable, Sendable, Equatable {
  public let tokens: TokenPairDTO

  public init(tokens: TokenPairDTO) {
    self.tokens = tokens
  }
}

// MARK: - MFA verify

public struct MfaVerifyRequestDTO: Codable, Sendable, Equatable {
  public let challengeId: String
  public let code: String

  public init(challengeId: String, code: String) {
    self.challengeId = challengeId
    self.code = code
  }
}

public struct MfaVerifyResponseDTO: Decodable, Sendable, Equatable {
  public let user: UserSummaryDTO
  public let tokens: TokenPairDTO

  public init(user: UserSummaryDTO, tokens: TokenPairDTO) {
    self.user = user
    self.tokens = tokens
  }
}
