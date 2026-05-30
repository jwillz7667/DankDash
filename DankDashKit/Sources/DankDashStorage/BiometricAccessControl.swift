import Foundation
import Security

/// Encapsulates `SecAccessControl` creation for biometric-guarded
/// Keychain items. Spec §5.1: the refresh token must be unlocked by
/// the user's current biometric set; if Face ID / Touch ID is changed
/// the protected item should become inaccessible (`biometryCurrentSet`
/// — not the more permissive `biometryAny`).
public enum BiometricAccessControl {
  /// Builds the `SecAccessControl` with the strictest biometric
  /// guarantee available. Thrown errors carry the underlying `CFError`
  /// from the Security framework so test fixtures can pattern-match
  /// without leaking the CF type at the call site.
  public static func makeAccessControl() throws -> SecAccessControl {
    var error: Unmanaged<CFError>?
    let accessControl = SecAccessControlCreateWithFlags(
      nil,
      kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
      [.biometryCurrentSet],
      &error
    )
    if let error = error?.takeRetainedValue() {
      throw BiometricAccessControlError.creationFailed(error as Error)
    }
    guard let accessControl else {
      throw BiometricAccessControlError.missing
    }
    return accessControl
  }
}

public enum BiometricAccessControlError: Error, Sendable {
  case creationFailed(Error)
  case missing
}
