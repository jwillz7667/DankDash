import Foundation

/// Process-lifetime in-memory cache for the refresh token.
///
/// The tokens live in the Keychain as `.afterFirstUnlock` items, so the
/// 401-refresh path can always read them non-interactively. This cache is
/// a small optimization on top of that: login/registration and each token
/// rotation prime it, and `TokenStore.live` / the `AuthInterceptor`
/// consult it first so a hot session skips even the cheap keychain
/// round-trip.
///
/// One instance per app process, created in the composition root and
/// shared by the `AuthInterceptor` and `TokenStore.live` so both observe
/// the same session. Memory-only by design: it dies with the process and
/// is re-primed from the keychain on the next cold launch.
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
