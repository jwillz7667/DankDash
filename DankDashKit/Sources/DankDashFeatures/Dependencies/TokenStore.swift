import Foundation
import ComposableArchitecture
import DankDashNetwork
import DankDashStorage

/// `@DependencyClient`-style wrapper around the Keychain so reducers
/// don't import Security directly and tests can stub the surface.
public struct TokenStore: Sendable {
  public var loadAccess: @Sendable () async -> String?
  public var loadRefresh: @Sendable () async -> String?
  /// Cheap "is a session stored?" probe consumed by the root reducers on
  /// launch. It must **never** decrypt the biometric-protected refresh
  /// token: doing so triggers a Face ID challenge on every cold start —
  /// and a `SIGABRT` when `NSFaceIDUsageDescription` is absent (the cause
  /// of the consumer launch crash). `live` backs this with a Keychain
  /// presence query that matches attributes only; the biometric decrypt
  /// is deferred to the genuine 401-refresh path that actually needs the
  /// token's bytes.
  public var hasSession: @Sendable () async -> Bool
  public var persist: @Sendable (TokenPairDTO) async -> Void
  public var clear: @Sendable () async -> Void

  public init(
    loadAccess: @Sendable @escaping () async -> String?,
    loadRefresh: @Sendable @escaping () async -> String?,
    persist: @Sendable @escaping (TokenPairDTO) async -> Void,
    clear: @Sendable @escaping () async -> Void,
    hasSession: (@Sendable () async -> Bool)? = nil
  ) {
    self.loadAccess = loadAccess
    self.loadRefresh = loadRefresh
    self.persist = persist
    self.clear = clear
    // When a caller doesn't supply an explicit probe (tests, the
    // in-memory store), derive it from the token getters so existing
    // semantics are preserved. `live` overrides this with a
    // non-decrypting Keychain presence check.
    self.hasSession = hasSession ?? {
      let access = await loadAccess()
      let refresh = await loadRefresh()
      return access != nil && refresh != nil
    }
  }
}

public extension TokenStore {
  /// Production binding backed by KeychainStore. Access token uses
  /// afterFirstUnlock; refresh token uses biometric protection per
  /// spec §5.1.
  static func live(keychain: KeychainStore) -> TokenStore {
    TokenStore(
      loadAccess: { try? keychain.optionalString(forAccount: AccountKey.access) },
      loadRefresh: { try? keychain.optionalString(forAccount: AccountKey.refresh) },
      persist: { tokens in
        try? keychain.setString(
          tokens.accessToken,
          forAccount: AccountKey.access,
          protection: .afterFirstUnlock
        )
        try? keychain.setString(
          tokens.refreshToken,
          forAccount: AccountKey.refresh,
          protection: .biometric
        )
      },
      clear: {
        try? keychain.remove(account: AccountKey.access)
        try? keychain.remove(account: AccountKey.refresh)
      },
      hasSession: {
        // Presence-only — never decrypts the biometric refresh token,
        // so launch never triggers Face ID (or its TCC crash).
        keychain.contains(account: AccountKey.access)
          && keychain.contains(account: AccountKey.refresh)
      }
    )
  }

  static let inMemory: TokenStore = {
    let storage = ActorIsolatedTokens()
    return TokenStore(
      loadAccess: { await storage.access },
      loadRefresh: { await storage.refresh },
      persist: { tokens in await storage.set(access: tokens.accessToken, refresh: tokens.refreshToken) },
      clear: { await storage.clear() }
    )
  }()

  static let unimplemented = TokenStore(
    loadAccess: { nil },
    loadRefresh: { nil },
    persist: { _ in },
    clear: {}
  )

  /// Keychain account names shared by `TokenStore.live` and any matching
  /// `AuthInterceptor` implementation in the app target. Lives here so
  /// the two halves of the auth flow agree on a single name pair.
  enum AccountKey {
    public static let access = "auth.access_token"
    public static let refresh = "auth.refresh_token"
  }
}

private actor ActorIsolatedTokens {
  var access: String?
  var refresh: String?

  func set(access: String, refresh: String) {
    self.access = access
    self.refresh = refresh
  }

  func clear() {
    access = nil
    refresh = nil
  }
}

private enum TokenStoreKey: DependencyKey {
  static let liveValue: TokenStore = .unimplemented
  static let testValue: TokenStore = .unimplemented
}

public extension DependencyValues {
  var tokenStore: TokenStore {
    get { self[TokenStoreKey.self] }
    set { self[TokenStoreKey.self] = newValue }
  }
}
