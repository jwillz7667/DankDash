import Foundation
import ComposableArchitecture
import DankDashNetwork
import DankDashStorage
import DankDashFeatures

/// Composition root for the DankDasher driver app. Mirrors the
/// consumer's `AppEnvironment` shape — one shared `APIClient` with the
/// production `LiveAuthInterceptor` and a per-target Keychain service
/// name — and adds the driver-specific live bindings (location,
/// battery, shift, heatmap, onboarding, document picker, session/draft
/// stores). The reducers consume these via `@Dependency` so the
/// composition is the only place that knows the live wiring.
///
/// Keychain service is `com.dankdash.driver.auth` so a consumer app
/// session on the same device doesn't collide with a driver session.
/// The two binaries can both be installed during dogfooding without
/// either flushing the other's tokens.
struct AppEnvironment {
  let apiBaseURL: URL
  let realtimeBaseURL: URL
  let cdnBaseURL: URL?
  let keychain: KeychainStore
  /// Shared APIClient. Built once during `.live` initialization so the
  /// reducer dependency graph and the ``DankDasherAppDelegate``
  /// APNs-registration path share the same instance — same baseURL,
  /// same auth interceptor, same in-flight refresh-token coordination.
  let apiClient: APIClient
  /// Auth interceptor backing ``apiClient`` and the realtime client's
  /// access-token getter. Exposed so any code path that needs a
  /// freshly-refreshed token (e.g. realtime reconnect) can pull from
  /// the same coordinator without instantiating a second interceptor.
  fileprivate let interceptor: LiveAuthInterceptor

  static let live: AppEnvironment = {
    let base = Self.resolvedAPIBaseURL()
    let realtime = Self.resolvedRealtimeBaseURL()
    let cdn = Self.resolvedCDNBaseURL()
    let keychain = KeychainStore(service: "com.dankdash.driver.auth")
    let interceptor = LiveAuthInterceptor(keychain: keychain)
    let apiClient = APIClient(
      baseURL: base,
      session: URLSession(configuration: .ephemeral),
      interceptor: interceptor
    )
    return AppEnvironment(
      apiBaseURL: base,
      realtimeBaseURL: realtime,
      cdnBaseURL: cdn,
      keychain: keychain,
      apiClient: apiClient,
      interceptor: interceptor
    )
  }()

  func prepareDependencies(_ dependencies: inout DependencyValues) {
    // Shared auth stack (same JWT public key, same refresh endpoint as
    // the consumer app — RS256 ES256 keys live on the server).
    dependencies.authAPIClient = .live(apiClient: apiClient)
    dependencies.tokenStore = .live(keychain: keychain)
    dependencies.cdnBaseURL = cdnBaseURL

    // Driver-specific read/write surface (Phase 8 + Phase 20 endpoints).
    dependencies.driverAppAPIClient = .live(apiClient: apiClient)
    dependencies.driverShiftAPIClient = .live(apiClient: apiClient)
    dependencies.driverHeatmapAPIClient = .live(apiClient: apiClient)
    dependencies.driverOnboardingAPIClient = .live(apiClient: apiClient)
    dependencies.dispatchOfferAPIClient = .live(apiClient: apiClient)
    dependencies.offerSubscriptionClient = .live(apiClient: apiClient)
    dependencies.hapticsClient = .live

    // Local persistence — driver session lives in a per-target
    // UserDefaults suite; document drafts + application draft live in
    // the per-target Application Support directory.
    dependencies.driverSessionStoreClient = .live()
    dependencies.driverApplicationDraftStoreClient = .live()
    dependencies.documentDraftStoreClient = .live()

    // Hardware coordinators — `CLLocationManager` (with the `location`
    // background mode entitlement) + `UIDevice.batteryLevel`.
    dependencies.backgroundLocationClient = .live
    dependencies.batteryMonitorClient = .live

    // Map helpers — bounding-region math + the Apple Maps hand-off the
    // active-route "Open in Maps" button shells out to.
    dependencies.mapClient = .live

    // Delivery-scoped realtime: publishes the driver's live location to
    // the `/driver` Socket.io namespace (the consumer's tracking map
    // consumes it) and observes `order:status_changed` so the vendor
    // handoff reconciles the active-route UI without polling. Shares the
    // same auth coordinator as `apiClient`, so a reconnect pulls a
    // freshly-refreshed token.
    dependencies.driverRealtimeClient = .live(
      baseURL: realtimeBaseURL,
      accessToken: { [interceptor] in try await interceptor.accessToken() }
    )

    // I/O surfaces — file picker for onboarding documents,
    // notifications for offer pushes (Phase 20 wires the offer-receipt
    // side; the registration path itself lives in the app delegate).
    dependencies.documentPickerClient = .live
    dependencies.pushNotificationClient = .live
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

  /// Socket.io endpoint for the `/driver` realtime namespace (Phase 22
  /// activates it). The URL is resolved at composition time so the
  /// Phase 20 client can pick it up without a second config pass.
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

  /// CDN base URL — same R2 bucket as the consumer app. Overridable
  /// via `DANKDASH_CDN_BASE_URL`. `nil` means the CDN is not
  /// configured for this build; downstream views degrade to
  /// placeholders.
  private static func resolvedCDNBaseURL() -> URL? {
    if let override = Bundle.main.object(forInfoDictionaryKey: "DANKDASH_CDN_BASE_URL") as? String,
       let url = URL(string: override) {
      return url
    }
    return URL(string: "https://cdn.dankdash.com")
  }
}

/// Production `AuthInterceptor` implementation: bearer-token injection
/// and refresh-token retrieval go through the same Keychain entries
/// `TokenStore.live` maps onto, so a token persisted by sign-in is
/// the same one the APIClient injects on the next authenticated call.
/// Refresh-token reads incur a biometric challenge per spec §5.1 —
/// that only happens on the 401-refresh-retry path, never on the
/// happy path.
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
