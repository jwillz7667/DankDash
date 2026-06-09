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
  let realtimeBaseURL: URL
  let checkoutBaseURL: URL
  let cdnBaseURL: URL?
  let keychain: KeychainStore
  /// Shared APIClient. Created once during ``live`` initialization so the
  /// reducer dependency graph and the ``AppDelegate`` APNs-registration
  /// path use the same instance — same baseURL, same auth interceptor,
  /// same in-flight refresh-token coordination.
  let apiClient: APIClient
  /// Auth interceptor backing ``apiClient`` and the realtime client's
  /// access-token getter. Exposed so the realtime client can pick up the
  /// post-refresh token via a closure without instantiating a second
  /// interceptor.
  fileprivate let interceptor: LiveAuthInterceptor

  static let live: AppEnvironment = {
    let base = Self.resolvedAPIBaseURL()
    let realtime = Self.resolvedRealtimeBaseURL()
    let checkout = Self.resolvedCheckoutBaseURL()
    let cdn = Self.resolvedCDNBaseURL()
    let keychain = KeychainStore(service: "com.dankdash.consumer.auth")
    let interceptor = LiveAuthInterceptor(keychain: keychain)
    let apiClient = APIClient(
      baseURL: base,
      session: URLSession(configuration: .ephemeral),
      interceptor: interceptor
    )
    return AppEnvironment(
      apiBaseURL: base,
      realtimeBaseURL: realtime,
      checkoutBaseURL: checkout,
      cdnBaseURL: cdn,
      keychain: keychain,
      apiClient: apiClient,
      interceptor: interceptor
    )
  }()

  func prepareDependencies(_ dependencies: inout DependencyValues) {
    dependencies.authAPIClient = .live(apiClient: apiClient)
    dependencies.tokenStore = .live(keychain: keychain)
    dependencies.catalogAPIClient = .live(apiClient: apiClient)
    dependencies.catalogCacheClient = .live()
    dependencies.locationClient = .live
    dependencies.documentDownloadClient = .live
    dependencies.cdnBaseURL = cdnBaseURL

    // Phase-18 additions: cart + orders + addresses + handoff +
    // realtime + storage + URL opener + map + push. Every reducer
    // pulls these via `@Dependency`, so they need a live binding
    // before the root store is constructed.
    dependencies.cartAPIClient = .live(apiClient: apiClient)
    dependencies.ordersAPIClient = .live(apiClient: apiClient)
    dependencies.meAPIClient = .live(apiClient: apiClient)
    dependencies.addressAPIClient = .live(apiClient: apiClient)
    dependencies.paymentMethodAPIClient = .live(
      apiClient: apiClient,
      returnURL: Self.resolvedPaymentLinkReturnURL()
    )
    dependencies.notificationPreferencesAPIClient = .live(apiClient: apiClient)
    dependencies.handoffAPIClient = .live(apiClient: apiClient)
    dependencies.realtimeClient = .live(
      baseURL: realtimeBaseURL,
      accessToken: { [interceptor] in try await interceptor.accessToken() }
    )
    dependencies.orderCacheClient = .live()
    dependencies.cartIdStoreClient = .live()
    dependencies.urlOpenerClient = .live
    dependencies.mapClient = .live
    dependencies.pushNotificationClient = .live
    dependencies.geocodingClient = .live
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

  /// Absolute URL Aeropay redirects to after the user finishes the hosted
  /// bank-link flow. The SFSafariViewController flow doesn't intercept the
  /// redirect — the `bank_account.linked` webhook is the source of truth —
  /// so this just needs to be a real landing page on the app web host.
  /// Overridable via the `DANKDASH_PAYMENT_LINK_RETURN_URL` Info.plist key
  /// so staging / preview builds can point at a non-production host.
  private static func resolvedPaymentLinkReturnURL() -> URL {
    if let override = Bundle.main.object(
      forInfoDictionaryKey: "DANKDASH_PAYMENT_LINK_RETURN_URL"
    ) as? String, let url = URL(string: override) {
      return url
    }
    return URL(string: "https://app.dankdash.com/payment-methods/linked")!
  }

  /// Socket.io endpoint for ``RealtimeClient``. Debug builds default to
  /// the local realtime server (`apps/realtime` on port 8081);
  /// production uses `wss://realtime.dankdash.com`. The
  /// `DANKDASH_REALTIME_BASE_URL` Info.plist key allows staging /
  /// preview builds to point at a non-default host.
  private static func resolvedRealtimeBaseURL() -> URL {
    if let override = Bundle.main.object(forInfoDictionaryKey: "DANKDASH_REALTIME_BASE_URL") as? String,
       let url = URL(string: override) {
      return url
    }
    #if DEBUG
    return URL(string: "http://localhost:8081")!
    #else
    return URL(string: "https://realtime.dankdash.com")!
    #endif
  }

  /// CDN base URL used for image / document composition. Overridable
  /// via the `DANKDASH_CDN_BASE_URL` Info.plist key. A nil result means
  /// the CDN isn't configured — views degrade to placeholder graphics
  /// and the COA flow surfaces a typed error.
  private static func resolvedCDNBaseURL() -> URL? {
    if let override = Bundle.main.object(forInfoDictionaryKey: "DANKDASH_CDN_BASE_URL") as? String,
       let url = URL(string: override) {
      return url
    }
    return URL(string: "https://cdn.dankdash.com")
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
