import Foundation
import ComposableArchitecture
import DankDashNetwork
import DankDashStorage
import DankDashFeatures

/// Composition root for the consumer iOS app. Owns the singleton
/// APIClient + KeychainStore wiring and exposes a `prepareDependencies`
/// helper so the @main entrypoint can register the live closure-backed
/// dependencies the reducers consume via `@Dependency`.
///
/// Apple §10.4 constraint: this app is menu-only. Checkout redirects to
/// a Safari view on `app.dankdash.com`. The `checkoutBaseURL` here is
/// declared today so when Phase 18 wires the SFSafariViewController
/// handoff, the URL is already centralized — no consumer-app code path
/// should ever build a checkout surface.
struct AppEnvironment {
  let apiBaseURL: URL
  let checkoutBaseURL: URL
  let keychain: KeychainStore

  static let live: AppEnvironment = {
    let base = Self.resolvedAPIBaseURL()
    let checkout = Self.resolvedCheckoutBaseURL()
    return AppEnvironment(
      apiBaseURL: base,
      checkoutBaseURL: checkout,
      keychain: KeychainStore(service: "com.dankdash.consumer.auth")
    )
  }()

  func prepareDependencies(_ dependencies: inout DependencyValues) {
    let interceptor = LiveAuthInterceptor(keychain: keychain)
    let apiClient = APIClient(
      baseURL: apiBaseURL,
      session: URLSession(configuration: .ephemeral),
      interceptor: interceptor
    )
    dependencies.authAPIClient = .live(apiClient: apiClient)
    dependencies.tokenStore = .live(keychain: keychain)
  }

  /// API base URL is overridable via the `DANKDASH_API_BASE_URL`
  /// Info.plist key so CI + staging builds can point at a different
  /// host without recompiling. Falls back to production for Release
  /// and the local dev API for Debug.
  private static func resolvedAPIBaseURL() -> URL {
    if let override = Bundle.main.object(forInfoDictionaryKey: "DANKDASH_API_BASE_URL") as? String,
       let url = URL(string: override) {
      return url
    }
    #if DEBUG
    return URL(string: "http://localhost:3000")!
    #else
    return URL(string: "https://api.dankdash.com")!
    #endif
  }

  private static func resolvedCheckoutBaseURL() -> URL {
    if let override = Bundle.main.object(forInfoDictionaryKey: "DANKDASH_CHECKOUT_BASE_URL") as? String,
       let url = URL(string: override) {
      return url
    }
    return URL(string: "https://app.dankdash.com/checkout")!
  }
}

/// Production `AuthInterceptor` implementation: bearer-token injection
/// and refresh-token retrieval go through the same Keychain entries the
/// reducers' `TokenStore.live` maps onto, so a token persisted by login
/// is the same one the APIClient injects on the next authenticated call.
/// Refresh-token reads incur a biometric challenge per spec §5.1 — that
/// only happens on the 401-refresh-retry path, never on the happy path.
private actor LiveAuthInterceptor: AuthInterceptor {
  private let keychain: KeychainStore

  init(keychain: KeychainStore) {
    self.keychain = keychain
  }

  func accessToken() async throws -> String {
    guard let token = try? keychain.optionalString(forAccount: TokenStore.AccountKey.access) else {
      throw APIError.unauthorized
    }
    return token
  }

  func refreshToken() async -> String? {
    try? keychain.optionalString(forAccount: TokenStore.AccountKey.refresh)
  }

  func persist(tokens: TokenPairDTO) async {
    try? keychain.setString(
      tokens.accessToken,
      forAccount: TokenStore.AccountKey.access,
      protection: .afterFirstUnlock
    )
    try? keychain.setString(
      tokens.refreshToken,
      forAccount: TokenStore.AccountKey.refresh,
      protection: .biometric
    )
  }

  func clearTokens() async {
    try? keychain.remove(account: TokenStore.AccountKey.access)
    try? keychain.remove(account: TokenStore.AccountKey.refresh)
  }
}
