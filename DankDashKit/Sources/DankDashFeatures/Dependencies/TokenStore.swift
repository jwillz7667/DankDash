import Foundation
import ComposableArchitecture
import DankDashNetwork
import DankDashStorage

/// `@DependencyClient`-style wrapper around the Keychain so reducers
/// don't import Security directly and tests can stub the surface.
public struct TokenStore: Sendable {
  public var loadAccess: @Sendable () async -> String?
  public var loadRefresh: @Sendable () async -> String?
  public var persist: @Sendable (TokenPairDTO) async -> Void
  public var clear: @Sendable () async -> Void

  public init(
    loadAccess: @Sendable @escaping () async -> String?,
    loadRefresh: @Sendable @escaping () async -> String?,
    persist: @Sendable @escaping (TokenPairDTO) async -> Void,
    clear: @Sendable @escaping () async -> Void
  ) {
    self.loadAccess = loadAccess
    self.loadRefresh = loadRefresh
    self.persist = persist
    self.clear = clear
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
