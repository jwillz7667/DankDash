import Foundation
import os
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
  /// Process-lifetime home of the decrypted refresh token. Shared by the
  /// interceptor, `TokenStore.live`, and `SessionUnlockClient.live` so
  /// the launch-time unlock gate decrypts once and every later refresh
  /// reads memory instead of re-raising a Face ID sheet.
  let sessionTokenCache: SessionTokenCache
  /// Snapshot/compare of the device's biometric enrollment digest. The
  /// unlock gate and login record the baseline; the foreground re-check
  /// and the token-rotation guard compare against it so a re-enrollment
  /// can't keep a session alive past the Keychain invalidation.
  let biometryEnrollment: BiometryEnrollmentMonitor
  /// Shared APIClient. Created once during ``live`` initialization so the
  /// reducer dependency graph and the ``AppDelegate`` APNs-registration
  /// path use the same instance — same baseURL, same auth interceptor,
  /// same in-flight refresh-token coordination.
  let apiClient: APIClient

  static let live: AppEnvironment = {
    let base = Self.resolvedAPIBaseURL()
    let realtime = Self.resolvedRealtimeBaseURL()
    let checkout = Self.resolvedCheckoutBaseURL()
    let cdn = Self.resolvedCDNBaseURL()
    let keychain = KeychainStore(service: "com.dankdash.consumer.auth")
    let sessionTokenCache = SessionTokenCache()
    let biometryEnrollment = BiometryEnrollmentMonitor()
    let interceptor = LiveAuthInterceptor(
      keychain: keychain,
      cache: sessionTokenCache,
      enrollment: biometryEnrollment
    )
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
      sessionTokenCache: sessionTokenCache,
      biometryEnrollment: biometryEnrollment,
      apiClient: apiClient
    )
  }()

  func prepareDependencies(_ dependencies: inout DependencyValues) {
    dependencies.authAPIClient = .live(apiClient: apiClient)
    dependencies.tokenStore = .live(
      keychain: keychain,
      cache: sessionTokenCache,
      enrollment: biometryEnrollment
    )
    dependencies.sessionUnlockClient = .live(
      keychain: keychain,
      cache: sessionTokenCache,
      enrollment: biometryEnrollment,
      reason: "Unlock your saved DankDash session"
    )
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
    dependencies.checkoutAPIClient = .live(apiClient: apiClient)
    dependencies.ordersAPIClient = .live(apiClient: apiClient)
    dependencies.meAPIClient = .live(apiClient: apiClient)
    dependencies.addressAPIClient = .live(apiClient: apiClient)
    dependencies.paymentMethodAPIClient = .live(
      apiClient: apiClient,
      returnURL: Self.resolvedPaymentLinkReturnURL()
    )
    dependencies.notificationPreferencesAPIClient = .live(apiClient: apiClient)
    dependencies.handoffAPIClient = .live(apiClient: apiClient)
    // `validAccessToken()` (not a raw Keychain read): the Socket.io
    // handshake replays whatever token it was handed, with no 401-retry
    // layer, so a JWT past its 15-min TTL must be refreshed *before*
    // the handshake — otherwise the `/customer` middleware rejects with
    // TOKEN_EXPIRED every time a tracking screen opens late.
    dependencies.realtimeClient = .live(
      baseURL: realtimeBaseURL,
      accessToken: { [apiClient] in try await apiClient.validAccessToken() }
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
/// The refresh token is written with `.biometricWithDeviceFallback`, the
/// same mode `TokenStore.live` uses, so a passcode-less device still keeps
/// the user signed in across launches instead of dropping the session.
///
/// The 401-refresh path **never** prompts: it reads the process-lifetime
/// ``SessionTokenCache`` first (primed by the launch unlock gate or a
/// fresh login) and falls back to a non-interactive Keychain read for
/// fallback-stored items only. A biometric-protected item that isn't in
/// the cache yields `nil` → `APIError.noRefreshToken`, surfacing as a
/// sign-in-again error instead of a surprise Face ID sheet.
private actor LiveAuthInterceptor: AuthInterceptor {
  private let keychain: KeychainStore
  private let cache: SessionTokenCache
  private let enrollment: BiometryEnrollmentMonitor
  /// Logs only error *types* on persist failure — never token bytes.
  private let log = Logger(subsystem: "Res.DankDash", category: "AuthInterceptor")

  init(keychain: KeychainStore, cache: SessionTokenCache, enrollment: BiometryEnrollmentMonitor) {
    self.keychain = keychain
    self.cache = cache
    self.enrollment = enrollment
  }

  func accessToken() async throws -> String {
    guard let token = try? keychain.optionalString(forAccount: TokenStore.AccountKey.access) else {
      throw APIError.unauthorized
    }
    return token
  }

  func refreshToken() async -> String? {
    if let cached = await cache.currentRefreshToken() { return cached }
    guard
      case .value(let token) =
        try? keychain.nonInteractiveString(forAccount: TokenStore.AccountKey.refresh)
    else {
      return nil
    }
    await cache.setRefreshToken(token)
    return token
  }

  func persist(tokens: TokenPairDTO) async {
    // A biometric re-enrollment already invalidated the stored refresh
    // item; rewriting it here would bind the session to the NEW biometric
    // set and resurrect it across cold launches. Refuse the write and
    // drop the in-memory copy — the next 401 fails into sign-in-again.
    guard !enrollment.hasEnrollmentChanged() else {
      log.error("Refusing token persist: biometric enrollment changed since unlock")
      await cache.clear()
      return
    }
    do {
      try keychain.setString(
        tokens.accessToken,
        forAccount: TokenStore.AccountKey.access,
        protection: .afterFirstUnlock
      )
    } catch {
      log.error("Failed to persist access token: \(String(describing: error), privacy: .public)")
    }
    do {
      try keychain.setString(
        tokens.refreshToken,
        forAccount: TokenStore.AccountKey.refresh,
        protection: .biometricWithDeviceFallback
      )
    } catch {
      log.error("Failed to persist refresh token: \(String(describing: error), privacy: .public)")
    }
    // The rotated refresh token must land in the cache too — the next
    // refresh reads memory, and the Keychain copy is biometric-locked.
    await cache.setRefreshToken(tokens.refreshToken)
  }

  func clearTokens() async {
    try? keychain.remove(account: TokenStore.AccountKey.access)
    try? keychain.remove(account: TokenStore.AccountKey.refresh)
    await cache.clear()
  }
}
