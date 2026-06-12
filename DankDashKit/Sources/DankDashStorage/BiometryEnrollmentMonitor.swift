import Foundation
import LocalAuthentication

/// Detects biometric re-enrollment across the lifetime of a session.
///
/// iOS invalidates a `.biometryCurrentSet`-protected Keychain item the
/// moment the enrollment changes — but only the *Keychain copy*. A warm
/// ``SessionTokenCache`` would keep refreshing the session until process
/// death, and worse, the next token rotation rewrites the refresh item
/// with a fresh `SecAccessControl` bound to the **new** biometric set,
/// resurrecting the session across cold launches. This monitor closes
/// that hole: it snapshots an opaque enrollment digest
/// (`LAContext.domainState.biometry.stateHash`) when a session is
/// unlocked or freshly created, and reports a mismatch so callers can
/// tear the session down.
///
/// Nil-hash rule: the digest reads `nil` whenever biometry is
/// unavailable — not enrolled, hardware-less, or **the device is locked**
/// (a driver's phone in a mount mid-shift). `nil` therefore always means
/// "unknown", never "changed"; only a non-nil ≠ non-nil comparison
/// reports a change. The digest is an opaque enrollment hash, not
/// Restricted data, so `UserDefaults` is an acceptable home.
///
/// `@unchecked Sendable` follows the ``UserDefaultsStore`` precedent —
/// `UserDefaults` is documented thread-safe; the struct itself is
/// value-semantic and immutable.
public struct BiometryEnrollmentMonitor: @unchecked Sendable {
  private let defaults: UserDefaults
  private let key: String
  private let currentHash: @Sendable () -> Data?

  /// `currentHash` is injectable for tests; production omits it and
  /// reads the device's live enrollment digest.
  public init(
    defaults: UserDefaults = .standard,
    key: String = "auth.biometry_enrollment_baseline",
    currentHash: (@Sendable () -> Data?)? = nil
  ) {
    self.defaults = defaults
    self.key = key
    self.currentHash = currentHash ?? Self.deviceEnrollmentHash
  }

  /// Adopts the current enrollment as the trusted baseline. Call when a
  /// session becomes legitimately unlocked: a successful gate unlock or
  /// a fresh password login. No-ops while the digest is unreadable.
  public func recordBaseline() {
    guard let hash = currentHash() else { return }
    defaults.set(hash, forKey: key)
  }

  /// Drops the baseline so a signed-out device carries no stale snapshot
  /// into the next account's session.
  public func clearBaseline() {
    defaults.removeObject(forKey: key)
  }

  /// `true` only when the device's enrollment digest is readable AND
  /// differs from the recorded baseline. A missing baseline (install
  /// predating this build, or first check after ``clearBaseline()``)
  /// adopts the current digest instead of reporting a change.
  public func hasEnrollmentChanged() -> Bool {
    guard let current = currentHash() else { return false }
    guard let baseline = defaults.data(forKey: key) else {
      defaults.set(current, forKey: key)
      return false
    }
    return baseline != current
  }

  /// `LAContext.domainState` needs iOS 18 / macOS 15; below that the
  /// monitor is inert (`nil` ⇒ "unknown"). Both apps deploy at iOS 26 so
  /// the guard only affects the macOS 14 package floor used by tests.
  private static let deviceEnrollmentHash: @Sendable () -> Data? = {
    guard #available(iOS 18.0, macOS 15.0, *) else { return nil }
    let context = LAContext()
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
      return nil
    }
    return context.domainState.biometry.stateHash
  }
}
