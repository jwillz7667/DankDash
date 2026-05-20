import Foundation

/// Abstracts the persistence + retrieval of the auth token pair so the
/// APIClient doesn't depend on Keychain directly (and tests can plug in
/// an in-memory implementation).
///
/// Mark conformers `Sendable`; the APIClient holds the interceptor
/// across actor boundaries.
public protocol AuthInterceptor: Sendable {
  /// Current access token. Throws `APIError.unauthorized` when none is
  /// available — usually means the session was cleared and the call
  /// shouldn't have been attempted.
  func accessToken() async throws -> String
  /// Current refresh token, if any. `nil` triggers `APIError.noRefreshToken`.
  func refreshToken() async -> String?
  /// Persists a fresh token pair after a login / register / refresh.
  func persist(tokens: TokenPairDTO) async
  /// Clears every stored credential — invoked on logout and on
  /// terminal 401s.
  func clearTokens() async
}

/// In-memory implementation used by tests and as a sane default in
/// previews. Production wires Keychain through `KeychainAuthInterceptor`
/// in DankDashFeatures so the access vs. refresh protection level is
/// applied correctly (afterFirstUnlock vs. biometric).
public actor InMemoryAuthInterceptor: AuthInterceptor {
  private var access: String?
  private var refresh: String?

  public init(access: String? = nil, refresh: String? = nil) {
    self.access = access
    self.refresh = refresh
  }

  public func accessToken() async throws -> String {
    guard let access else { throw APIError.unauthorized }
    return access
  }

  public func refreshToken() async -> String? { refresh }

  public func persist(tokens: TokenPairDTO) async {
    access = tokens.accessToken
    refresh = tokens.refreshToken
  }

  public func clearTokens() async {
    access = nil
    refresh = nil
  }
}
