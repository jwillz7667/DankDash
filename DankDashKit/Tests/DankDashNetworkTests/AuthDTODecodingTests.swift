import XCTest
@testable import DankDashNetwork

final class AuthDTODecodingTests: XCTestCase {
  private let decoder = JSONDecoder()

  func test_loginResponse_authenticatedBranchDecodes() throws {
    let json = """
    {
      "status": "authenticated",
      "user": \(userJSON),
      "tokens": \(tokensJSON)
    }
    """.data(using: .utf8)!

    let response = try decoder.decode(LoginResponseDTO.self, from: json)
    guard case let .authenticated(user, tokens) = response else {
      return XCTFail("expected .authenticated, got \(response)")
    }
    XCTAssertEqual(user.email, "you@dankdash.test")
    XCTAssertEqual(tokens.accessToken, "access.jwt.value")
    XCTAssertEqual(tokens.tokenType, "Bearer")
  }

  func test_loginResponse_mfaRequiredBranchDecodes() throws {
    let json = """
    {
      "status": "mfa_required",
      "challengeId": "550e8400-e29b-41d4-a716-446655440000",
      "challengeExpiresAt": "2026-06-01T12:00:00.000Z"
    }
    """.data(using: .utf8)!

    let response = try decoder.decode(LoginResponseDTO.self, from: json)
    guard case let .mfaRequired(challengeId, expires) = response else {
      return XCTFail("expected .mfaRequired, got \(response)")
    }
    XCTAssertEqual(challengeId, "550e8400-e29b-41d4-a716-446655440000")
    XCTAssertEqual(expires, "2026-06-01T12:00:00.000Z")
  }

  func test_loginResponse_unknownStatus_throws() {
    let json = """
    { "status": "limbo" }
    """.data(using: .utf8)!
    XCTAssertThrowsError(try decoder.decode(LoginResponseDTO.self, from: json))
  }

  func test_registerResponse_decodesUserAndTokens() throws {
    let json = """
    { "user": \(userJSON), "tokens": \(tokensJSON) }
    """.data(using: .utf8)!
    let response = try decoder.decode(RegisterResponseDTO.self, from: json)
    XCTAssertEqual(response.user.email, "you@dankdash.test")
    XCTAssertEqual(response.tokens.refreshToken, "refresh.opaque.value")
  }

  func test_refreshResponse_decodesTokens() throws {
    let json = """
    { "tokens": \(tokensJSON) }
    """.data(using: .utf8)!
    let response = try decoder.decode(RefreshResponseDTO.self, from: json)
    XCTAssertEqual(response.tokens.accessToken, "access.jwt.value")
  }

  func test_userSummary_toDomain_succeedsForWellFormedPayload() throws {
    let dto = try decoder.decode(UserSummaryDTO.self, from: userJSON.data(using: .utf8)!)
    let domain = dto.toDomain()
    XCTAssertNotNil(domain)
    XCTAssertEqual(domain?.email.rawValue, "you@dankdash.test")
    XCTAssertEqual(domain?.role.rawValue, "customer")
  }

  func test_userSummary_toDomain_returnsNilForMalformedID() throws {
    let json = """
    {
      "id": "not-a-uuid",
      "email": "you@dankdash.test",
      "phone": null,
      "firstName": null,
      "lastName": null,
      "role": "customer",
      "status": "active",
      "kycVerified": false,
      "mfaEnabled": false,
      "createdAt": "2026-01-15T10:00:00.000Z"
    }
    """.data(using: .utf8)!
    let dto = try decoder.decode(UserSummaryDTO.self, from: json)
    XCTAssertNil(dto.toDomain())
  }

  // MARK: - Fixtures

  private var userJSON: String {
    """
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "email": "you@dankdash.test",
      "phone": null,
      "firstName": "Test",
      "lastName": "User",
      "role": "customer",
      "status": "active",
      "kycVerified": false,
      "mfaEnabled": false,
      "createdAt": "2026-01-15T10:00:00.000Z"
    }
    """
  }

  private var tokensJSON: String {
    """
    {
      "accessToken": "access.jwt.value",
      "refreshToken": "refresh.opaque.value",
      "accessTokenExpiresAt": "2026-01-15T10:15:00.000Z",
      "refreshTokenExpiresAt": "2026-02-14T10:00:00.000Z",
      "tokenType": "Bearer"
    }
    """
  }
}
