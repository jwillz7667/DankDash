import Foundation
import os
import ComposableArchitecture
import DankDashNetwork
import DankDashStorage

/// Subsystem-scoped logger for the token store. Only ever logs error
/// *types* (a `KeychainError`/`BiometricAccessControlError`) — never the
/// token bytes — so it carries no Restricted data.
private let tokenStoreLog = Logger(subsystem: "com.dankdash", category: "TokenStore")

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
  /// afterFirstUnlock; refresh token uses biometric protection per spec
  /// §5.1, falling back to device-only where the hardware can't honor
  /// biometry (`.biometricWithDeviceFallback`) so the session always
  /// survives a relaunch instead of silently evaporating.
  ///
  /// `cache` is the process-lifetime home of the decrypted refresh
  /// token. `persist` primes it (a fresh login/registration *is* an
  /// unlocked session) and `loadRefresh` consults it first so no code
  /// path on this surface ever triggers an implicit Face ID challenge —
  /// the interactive decrypt belongs exclusively to
  /// ``SessionUnlockClient``.
  ///
  /// `enrollment`: a fresh login re-baselines the biometric enrollment
  /// snapshot (the new session is trusted under *today's* biometric set,
  /// even if it changed while signed out); sign-out drops the baseline so
  /// nothing stale carries into the next account.
  static func live(
    keychain: KeychainStore,
    cache: SessionTokenCache,
    enrollment: BiometryEnrollmentMonitor
  ) -> TokenStore {
    TokenStore(
      loadAccess: { try? keychain.optionalString(forAccount: AccountKey.access) },
      loadRefresh: {
        if let cached = await cache.currentRefreshToken() { return cached }
        guard case .value(let token) = try? keychain.nonInteractiveString(forAccount: AccountKey.refresh) else {
          return nil
        }
        await cache.setRefreshToken(token)
        return token
      },
      persist: { tokens in
        do {
          try keychain.setString(
            tokens.accessToken,
            forAccount: AccountKey.access,
            protection: .afterFirstUnlock
          )
        } catch {
          tokenStoreLog.error("Failed to persist access token: \(String(describing: error), privacy: .public)")
        }
        do {
          try keychain.setString(
            tokens.refreshToken,
            forAccount: AccountKey.refresh,
            protection: .biometricWithDeviceFallback
          )
        } catch {
          tokenStoreLog.error("Failed to persist refresh token: \(String(describing: error), privacy: .public)")
        }
        await cache.setRefreshToken(tokens.refreshToken)
        enrollment.recordBaseline()
      },
      clear: {
        try? keychain.remove(account: AccountKey.access)
        try? keychain.remove(account: AccountKey.refresh)
        await cache.clear()
        enrollment.clearBaseline()
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
