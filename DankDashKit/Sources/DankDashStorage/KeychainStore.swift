import Foundation
import LocalAuthentication
import Security

/// Errors surfaced by the Keychain wrapper. Each case carries the
/// underlying `OSStatus` so callers can branch on `errSecItemNotFound`
/// vs. genuine failures, but the enum keeps the `Security` framework
/// from leaking into call sites.
public enum KeychainError: Error, Equatable, Sendable {
  case unhandled(OSStatus)
  case decodingFailed
  case dataConversionFailed

  public var isItemNotFound: Bool {
    if case .unhandled(let status) = self { return status == errSecItemNotFound }
    return false
  }
}

/// Discriminator that determines how an item is protected. The biometric
/// variant attaches a `SecAccessControl` so the OS challenges Face ID /
/// Touch ID before yielding the bytes — spec §5.1 requires this for the
/// refresh token, but not for the (short-lived) access token.
public enum KeychainProtection: Sendable {
  case afterFirstUnlock
  case biometric
  /// Biometric protection where the hardware can honor it, transparently
  /// downgrading to device-only `afterFirstUnlock` where it cannot.
  ///
  /// The accessibility class `biometric` rides on
  /// (`kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`) makes `SecItemAdd`
  /// *fail* on a device with no passcode set — and on Simulators without an
  /// enrolled biometry + passcode. Persisting the refresh token under plain
  /// `.biometric` therefore threw, the call sites swallowed it with `try?`,
  /// the token was never stored, `hasSession()` read false on the next cold
  /// start, and the user was silently logged out (then re-shown the age
  /// gate, which only signed-out users see). This variant keeps the strict
  /// biometric guarantee wherever the device supports it and falls back to
  /// device-only protection otherwise, so a session always survives a
  /// relaunch. The fallback is strictly weaker than biometric but is applied
  /// only when the hardware can't satisfy the biometric constraint at all.
  case biometricWithDeviceFallback
}

/// Thin wrapper around the Security framework's `SecItem*` family.
/// Items are namespaced by a per-store `service` string so test runs
/// can use a unique service prefix and avoid bleeding into each other.
public struct KeychainStore: Sendable {
  public let service: String

  public init(service: String) {
    self.service = service
  }

  /// Store `data` under `account`. Overwrites any existing item for the
  /// same `service` + `account` pair.
  public func set(
    _ data: Data,
    forAccount account: String,
    protection: KeychainProtection = .afterFirstUnlock
  ) throws {
    let identity: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    SecItemDelete(identity as CFDictionary)

    switch protection {
    case .afterFirstUnlock:
      try add(data, identity: identity, accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
    case .biometric:
      try addBiometric(data, identity: identity)
    case .biometricWithDeviceFallback:
      do {
        try addBiometric(data, identity: identity)
      } catch {
        // Biometric protection is unavailable on this device (no passcode /
        // no enrolled biometry — e.g. a CI Simulator), so the add above
        // threw. Recover by storing the item device-only so the session
        // still persists across launches. Not a silent swallow: the
        // fallback write *is* the handling, and if it also fails its error
        // propagates to the caller. See `KeychainProtection` for why.
        try add(data, identity: identity, accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
      }
    }
  }

  /// UTF-8 string convenience that round-trips through `set(_:forAccount:protection:)`.
  public func setString(
    _ value: String,
    forAccount account: String,
    protection: KeychainProtection = .afterFirstUnlock
  ) throws {
    guard let data = value.data(using: .utf8) else { throw KeychainError.dataConversionFailed }
    try set(data, forAccount: account, protection: protection)
  }

  /// Retrieves the raw bytes stored at `account`. Throws when the item is
  /// missing — call sites should check `KeychainError.isItemNotFound`.
  public func data(forAccount account: String) throws -> Data {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]

    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess else { throw KeychainError.unhandled(status) }
    guard let data = result as? Data else { throw KeychainError.decodingFailed }
    return data
  }

  public func string(forAccount account: String) throws -> String {
    let bytes = try data(forAccount: account)
    guard let value = String(data: bytes, encoding: .utf8) else {
      throw KeychainError.decodingFailed
    }
    return value
  }

  /// Returns nil instead of throwing when the item is missing. All other
  /// errors still surface.
  public func optionalString(forAccount account: String) throws -> String? {
    do {
      return try string(forAccount: account)
    } catch let error as KeychainError where error.isItemNotFound {
      return nil
    }
  }

  /// Outcome of a read that refuses to present authentication UI. Lets a
  /// caller distinguish "the bytes are free" from "the bytes exist but the
  /// access control demands user authentication" without ever raising the
  /// Face ID sheet.
  public enum NonInteractiveRead: Equatable, Sendable {
    case value(String)
    /// The item exists but its `SecAccessControl` requires the user to
    /// authenticate before the OS will release the bytes.
    case requiresUserAuthentication
    case missing
  }

  /// Reads `account` while forbidding any authentication UI
  /// (`kSecUseAuthenticationUISkip`). Items stored with a plain
  /// accessibility class decrypt silently; biometric-protected items
  /// report `.requiresUserAuthentication` instead of prompting. This is
  /// the only read the token-refresh path is allowed to use — the
  /// interactive decrypt belongs to the explicit session-unlock gate.
  public func nonInteractiveString(forAccount account: String) throws -> NonInteractiveRead {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecUseAuthenticationUI as String: kSecUseAuthenticationUISkip,
    ]

    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    switch status {
    case errSecSuccess:
      guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
        throw KeychainError.decodingFailed
      }
      return .value(value)
    case errSecInteractionNotAllowed:
      return .requiresUserAuthentication
    case errSecItemNotFound:
      return .missing
    default:
      throw KeychainError.unhandled(status)
    }
  }

  /// Reads a (possibly biometric-protected) item using an `LAContext` the
  /// caller has already evaluated. Because the context carries a fresh
  /// authorization, the OS satisfies the item's access control without
  /// presenting a second prompt. `errSecItemNotFound` here can also mean
  /// the item was permanently invalidated by a biometry re-enrollment
  /// (`.biometryCurrentSet`) — callers must treat it as "session gone".
  public func string(forAccount account: String, authenticating context: LAContext) throws -> String {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecUseAuthenticationContext as String: context,
    ]

    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess else { throw KeychainError.unhandled(status) }
    guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
      throw KeychainError.decodingFailed
    }
    return value
  }

  /// Reports whether an item exists for `account` **without decrypting it**.
  ///
  /// This is the launch-safe counterpart to `data(forAccount:)` for
  /// biometric-protected items: returning the bytes forces a Face ID /
  /// Touch ID challenge (and, absent `NSFaceIDUsageDescription`, a TCC
  /// `SIGABRT`), but an existence match does not. The query omits every
  /// `kSecReturn*` flag and passes a nil result pointer so `SecItemCopyMatching`
  /// only matches attributes, and `kSecUseAuthenticationUI = kSecUseAuthenticationUISkip`
  /// guarantees no authentication UI is presented even if the OS would
  /// otherwise consider it. Use this for "is a session stored?" probes;
  /// defer the decrypt to the moment the value is actually consumed.
  public func contains(account: String) -> Bool {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecUseAuthenticationUI as String: kSecUseAuthenticationUISkip,
    ]
    return SecItemCopyMatching(query as CFDictionary, nil) == errSecSuccess
  }

  /// Removes the item. `errSecItemNotFound` is treated as success so the
  /// API is idempotent — call sites don't have to know whether the value
  /// was previously stored.
  public func remove(account: String) throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw KeychainError.unhandled(status)
    }
  }

  /// Best-effort wipe of every account under this service. Used on logout.
  public func removeAll() throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
    ]
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw KeychainError.unhandled(status)
    }
  }

  /// Adds an item guarded by a plain accessibility class (no access
  /// control). The slot is assumed already cleared by `set`.
  private func add(
    _ data: Data,
    identity: [String: Any],
    accessible: CFString
  ) throws {
    var query = identity
    query[kSecValueData as String] = data
    query[kSecAttrAccessible as String] = accessible
    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else { throw KeychainError.unhandled(status) }
  }

  /// Adds an item guarded by a biometric `SecAccessControl`. Throws if the
  /// device can't build/satisfy the control (no passcode / no enrolled
  /// biometry) — callers that need resilience use `.biometricWithDeviceFallback`.
  private func addBiometric(_ data: Data, identity: [String: Any]) throws {
    var query = identity
    query[kSecValueData as String] = data
    query[kSecAttrAccessControl as String] = try BiometricAccessControl.makeAccessControl()
    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else { throw KeychainError.unhandled(status) }
  }
}
