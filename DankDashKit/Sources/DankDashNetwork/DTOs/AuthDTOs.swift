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

// MARK: - Password reset

/// POST /v1/auth/forgot-password request body. The server answers 202 with no
/// body regardless of whether the email maps to an account (enumeration-safe),
/// so the client treats any success as "if that account exists, a code is on
/// its way". `email` is sent lowercased to match the citext column the account
/// was created against; the server also trims + lowercases defensively.
public struct ForgotPasswordRequestDTO: Codable, Sendable, Equatable {
  public let email: String

  public init(email: String) {
    self.email = email
  }
}

/// POST /v1/auth/reset-password request body. `code` is the human-typed reset
/// code from the email — the server normalizes confusable glyphs (O→0, I/L→1),
/// case, and separators, so the client forwards it verbatim. `newPassword` is
/// the plaintext the server argon2-hashes; the server re-validates the ≥12-char
/// letter+digit policy. 204 No Content on success.
public struct ResetPasswordRequestDTO: Codable, Sendable, Equatable {
  public let code: String
  public let newPassword: String

  public init(code: String, newPassword: String) {
    self.code = code
    self.newPassword = newPassword
  }
}
