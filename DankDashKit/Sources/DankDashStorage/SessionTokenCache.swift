import Foundation

/// Process-lifetime cache for the decrypted refresh token.
///
/// The refresh token is stored in the Keychain behind a biometric
/// `SecAccessControl`, which means every Keychain read of it costs a
/// Face ID challenge. Before this cache existed, the 401-refresh path
/// read the Keychain directly — so a system Face ID sheet appeared at
/// arbitrary moments roughly every access-token TTL (15 min), and a
/// canceled prompt killed the request. Now the explicit session-unlock
/// gate (and login/registration) decrypts the token **once** and parks
/// it here; every subsequent refresh reads memory and never prompts.
///
/// One instance per app process, created in the composition root and
/// shared by the `AuthInterceptor`, `TokenStore.live`, and
/// `SessionUnlockClient.live` so all three observe the same session.
/// The cache is memory-only by design: it dies with the process, which
/// is exactly when the unlock gate runs again.
public actor SessionTokenCache {
  private var refreshToken: String?

  public init() {}

  public func currentRefreshToken() -> String? {
    refreshToken
  }

  public func setRefreshToken(_ token: String?) {
    refreshToken = token
  }

  public func clear() {
    refreshToken = nil
  }
}
