import XCTest
@testable import DankDashNetwork

/// End-to-end tests of the APIClient using URLProtocolMock to script
/// HTTP responses. Verifies header injection, body shape, the
/// 401-refresh-retry dance, and error envelope propagation.
final class APIClientTests: XCTestCase {
  private var session: URLSession!
  private var client: APIClient!
  private var interceptor: InMemoryAuthInterceptor!

  private let baseURL = URL(string: "https://api.dankdash.test")!

  override func setUp() async throws {
    try await super.setUp()
    URLProtocolMock.reset()
    session = URLSession.mocked()
    interceptor = InMemoryAuthInterceptor(access: "initial.access", refresh: "initial.refresh")
    client = APIClient(
      baseURL: baseURL,
      session: session as URLSessionProtocol,
      interceptor: interceptor
    )
  }

  override func tearDown() async throws {
    URLProtocolMock.reset()
    session = nil
    client = nil
    interceptor = nil
    try await super.tearDown()
  }

  func test_login_sendsBodyAndDecodesAuthenticatedResponse() async throws {
    URLProtocolMock.handler = { request in
      XCTAssertEqual(request.url?.absoluteString, "https://api.dankdash.test/v1/auth/login")
      XCTAssertEqual(request.httpMethod, "POST")
      XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
      XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
      let response = HTTPURLResponse(
        url: request.url!,
        statusCode: 200,
        httpVersion: nil,
        headerFields: nil
      )!
      let body = """
      {
        "status": "authenticated",
        "user": \(Self.userJSON),
        "tokens": \(Self.tokensJSON)
      }
      """.data(using: .utf8)!
      return (response, body)
    }

    let response = try await client.send(
      AuthEndpoints.login(.init(email: "you@dankdash.test", password: "Sup3rsecret!"))
    )
    guard case let .authenticated(user, _) = response else {
      return XCTFail("expected authenticated branch, got \(response)")
    }
    XCTAssertEqual(user.email, "you@dankdash.test")
  }

  func test_authenticatedCall_setsBearerHeader() async throws {
    URLProtocolMock.handler = { request in
      XCTAssertEqual(
        request.value(forHTTPHeaderField: "Authorization"),
        "Bearer initial.access"
      )
      let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
      return (response, Self.userJSON.data(using: .utf8))
    }

    _ = try await client.send(MeEndpoints.current())
  }

  func test_401TriggersRefreshAndRetriesOnce() async throws {
    let originalRequestCount = LockedInt(0)

    URLProtocolMock.handler = { request in
      let path = request.url?.path ?? ""
      if path == "/v1/me" {
        let count = originalRequestCount.increment()
        if count == 1 {
          let response = HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!
          let envelope = """
          { "error": { "code": "AUTH_TOKEN_EXPIRED", "message": "expired", "details": {} } }
          """.data(using: .utf8)!
          return (response, envelope)
        } else {
          XCTAssertEqual(
            request.value(forHTTPHeaderField: "Authorization"),
            "Bearer refreshed.access"
          )
          let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
          return (response, Self.userJSON.data(using: .utf8))
        }
      }
      if path == "/v1/auth/refresh" {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        let body = """
        { "tokens": {
          "accessToken": "refreshed.access",
          "refreshToken": "refreshed.refresh",
          "accessTokenExpiresAt": "2026-01-15T10:15:00.000Z",
          "refreshTokenExpiresAt": "2026-02-14T10:00:00.000Z",
          "tokenType": "Bearer"
        }}
        """.data(using: .utf8)!
        return (response, body)
      }
      XCTFail("unexpected path: \(path)")
      let response = HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!
      return (response, nil)
    }

    let user = try await client.send(MeEndpoints.current())
    XCTAssertEqual(user.email, "you@dankdash.test")

    // After refresh, the interceptor should hold the new token pair.
    let newAccess = try await interceptor.accessToken()
    XCTAssertEqual(newAccess, "refreshed.access")
    XCTAssertEqual(originalRequestCount.value, 2)
  }

  func test_refreshFailureClearsTokensAndThrowsUnauthorized() async throws {
    URLProtocolMock.handler = { request in
      let path = request.url?.path ?? ""
      if path == "/v1/me" {
        let response = HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!
        let envelope = """
        { "error": { "code": "AUTH_TOKEN_EXPIRED", "message": "expired", "details": {} } }
        """.data(using: .utf8)!
        return (response, envelope)
      }
      if path == "/v1/auth/refresh" {
        let response = HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!
        let envelope = """
        { "error": { "code": "AUTH_REFRESH_REVOKED", "message": "revoked", "details": {} } }
        """.data(using: .utf8)!
        return (response, envelope)
      }
      XCTFail("unexpected path: \(path)")
      let response = HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!
      return (response, nil)
    }

    do {
      _ = try await client.send(MeEndpoints.current())
      XCTFail("expected throw")
    } catch let error as APIError {
      guard case .unauthorized = error else {
        return XCTFail("expected .unauthorized, got \(error)")
      }
    }
    let cleared = await interceptor.refreshToken()
    XCTAssertNil(cleared)
  }

  func test_missingRefreshToken_throwsNoRefreshToken() async throws {
    interceptor = InMemoryAuthInterceptor(access: "x", refresh: nil)
    client = APIClient(
      baseURL: baseURL,
      session: session as URLSessionProtocol,
      interceptor: interceptor
    )
    URLProtocolMock.handler = { request in
      let response = HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!
      return (response, nil)
    }

    do {
      _ = try await client.send(MeEndpoints.current())
      XCTFail("expected throw")
    } catch let error as APIError {
      guard case .noRefreshToken = error else {
        return XCTFail("expected .noRefreshToken, got \(error)")
      }
    }
  }

  func test_serverError_surfacesEnvelope() async throws {
    URLProtocolMock.handler = { request in
      let response = HTTPURLResponse(url: request.url!, statusCode: 409, httpVersion: nil, headerFields: nil)!
      let body = """
      { "error": { "code": "AUTH_EMAIL_TAKEN", "message": "already registered", "details": {} } }
      """.data(using: .utf8)!
      return (response, body)
    }

    do {
      _ = try await client.send(
        AuthEndpoints.register(.init(
          email: "x@dankdash.test",
          password: "Aaaaaaaaaaaa1",
          dateOfBirth: "2000-01-01",
          firstName: "X",
          lastName: "Y"
        ))
      )
      XCTFail("expected throw")
    } catch let error as APIError {
      guard case let .server(status, envelope) = error else {
        return XCTFail("expected .server, got \(error)")
      }
      XCTAssertEqual(status, 409)
      XCTAssertEqual(envelope.error.code, "AUTH_EMAIL_TAKEN")
    }
  }

  // MARK: - Fixtures

  private static let userJSON = """
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

  private static let tokensJSON = """
  {
    "accessToken": "access.jwt.value",
    "refreshToken": "refresh.opaque.value",
    "accessTokenExpiresAt": "2026-01-15T10:15:00.000Z",
    "refreshTokenExpiresAt": "2026-02-14T10:00:00.000Z",
    "tokenType": "Bearer"
  }
  """
}

/// Thread-safe Int counter so concurrent test handlers can increment
/// safely. NSLock works fine in Swift 6 strict concurrency.
private final class LockedInt: @unchecked Sendable {
  private let lock = NSLock()
  private var _value: Int

  init(_ value: Int) { self._value = value }

  func increment() -> Int {
    lock.lock(); defer { lock.unlock() }
    _value += 1
    return _value
  }

  var value: Int {
    lock.lock(); defer { lock.unlock() }
    return _value
  }
}
