import Foundation

/// Typed accessors over `UserDefaults` for state that's neither secret
/// (Keychain) nor large/relational (SwiftData/SQLite). Examples: age-gate
/// acknowledgment timestamp, last-used email so we can prefill, the
/// installed semver so we can react to upgrades on first-launch.
/// `UserDefaults` is documented thread-safe but isn't formally `Sendable`
/// in the SDK; we mark the wrapper `@unchecked Sendable` because the
/// struct is value-typed and the only stored reference is a thread-safe
/// system class.
public struct UserDefaultsStore: @unchecked Sendable {
  private let suiteName: String?
  private let defaults: UserDefaults

  public init(suiteName: String? = nil) {
    self.suiteName = suiteName
    if let suiteName, let suite = UserDefaults(suiteName: suiteName) {
      self.defaults = suite
    } else {
      self.defaults = .standard
    }
  }

  // MARK: - Generic accessors

  public func string(forKey key: Key) -> String? {
    defaults.string(forKey: key.rawValue)
  }

  public func setString(_ value: String?, forKey key: Key) {
    if let value {
      defaults.set(value, forKey: key.rawValue)
    } else {
      defaults.removeObject(forKey: key.rawValue)
    }
  }

  public func bool(forKey key: Key) -> Bool {
    defaults.bool(forKey: key.rawValue)
  }

  public func setBool(_ value: Bool, forKey key: Key) {
    defaults.set(value, forKey: key.rawValue)
  }

  public func date(forKey key: Key) -> Date? {
    defaults.object(forKey: key.rawValue) as? Date
  }

  public func setDate(_ value: Date?, forKey key: Key) {
    if let value {
      defaults.set(value, forKey: key.rawValue)
    } else {
      defaults.removeObject(forKey: key.rawValue)
    }
  }

  public func remove(_ key: Key) {
    defaults.removeObject(forKey: key.rawValue)
  }

  // MARK: - Convenience: age gate

  /// Returns true if the user has previously confirmed they're 21+.
  /// Re-prompted on app reinstall (UserDefaults clears) or when the
  /// caller explicitly invokes `clearAgeGate()`.
  public var hasPassedAgeGate: Bool { bool(forKey: .ageGatePassedAt) || date(forKey: .ageGatePassedAt) != nil }

  public func markAgeGatePassed(at date: Date = Date()) {
    setDate(date, forKey: .ageGatePassedAt)
  }

  public func clearAgeGate() {
    remove(.ageGatePassedAt)
  }

  // MARK: - Convenience: last-used email

  public var lastUsedEmail: String? {
    string(forKey: .lastUsedEmail)
  }

  public func setLastUsedEmail(_ value: String?) {
    setString(value, forKey: .lastUsedEmail)
  }
}

public extension UserDefaultsStore {
  enum Key: String, Sendable {
    case ageGatePassedAt = "dankdash.ageGate.passedAt"
    case lastUsedEmail = "dankdash.auth.lastUsedEmail"
    case lastSeenAppVersion = "dankdash.app.lastSeenVersion"
  }
}
