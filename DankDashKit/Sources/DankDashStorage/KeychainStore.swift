import Foundation
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
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    SecItemDelete(query as CFDictionary)

    query[kSecValueData as String] = data
    try applyAccessControl(protection: protection, to: &query)

    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else { throw KeychainError.unhandled(status) }
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

  private func applyAccessControl(
    protection: KeychainProtection,
    to query: inout [String: Any]
  ) throws {
    switch protection {
    case .afterFirstUnlock:
      query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    case .biometric:
      let accessControl = try BiometricAccessControl.makeAccessControl()
      query[kSecAttrAccessControl as String] = accessControl
    }
  }
}
