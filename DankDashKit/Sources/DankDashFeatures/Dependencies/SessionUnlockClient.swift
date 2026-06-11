import Foundation
import LocalAuthentication
import ComposableArchitecture
import DankDashStorage

/// Result of an explicit session-unlock attempt.
public enum SessionUnlockOutcome: Equatable, Sendable {
  /// The refresh token was decrypted and parked in the
  /// ``DankDashStorage/SessionTokenCache`` — the session is live and
  /// subsequent token refreshes are silent.
  case unlocked
  /// The user canceled or failed the authentication prompt. Retryable:
  /// the stored session is intact, the lock screen stays up.
  case canceled
  /// Biometry is OS-locked after repeated failed scans and the passcode
  /// recovery flow didn't complete. Retryable — but plain "try again"
  /// can never succeed, so the lock screen's copy must point the user
  /// at the passcode.
  case biometryLockedOut
  /// The stored session is unusable — the item is gone, or a biometry
  /// re-enrollment permanently invalidated it (`.biometryCurrentSet`).
  /// The caller must clear the session and route to login.
  case invalid
}

/// Closure-backed dependency for the launch-time session gate. The lock
/// screen reducer consumes it via `@Dependency(\.sessionUnlockClient)`;
/// the live binding is wired in each app's `AppEnvironment.prepareDependencies`.
///
/// This is the **only** surface allowed to decrypt the biometric-protected
/// refresh token interactively. Everything else (the 401-refresh path,
/// `TokenStore.loadRefresh`) reads the in-memory cache or does a
/// non-interactive Keychain read, so a Face ID sheet can never appear at
/// an arbitrary mid-session moment.
public struct SessionUnlockClient: Sendable {
  public var unlock: @Sendable () async -> SessionUnlockOutcome
  /// Foreground re-check: returns `true` — after clearing the in-memory
  /// token cache — when the device's biometric enrollment no longer
  /// matches the baseline recorded at unlock/login. iOS already
  /// invalidated the Keychain copy at that point; without this check a
  /// warm cache keeps the session refreshing until process death, and
  /// the next rotation would re-bind the refresh item to the *new*
  /// biometric set. Never prompts.
  public var invalidateSessionIfEnrollmentChanged: @Sendable () async -> Bool

  public init(
    unlock: @Sendable @escaping () async -> SessionUnlockOutcome,
    invalidateSessionIfEnrollmentChanged: @Sendable @escaping () async -> Bool = { false }
  ) {
    self.unlock = unlock
    self.invalidateSessionIfEnrollmentChanged = invalidateSessionIfEnrollmentChanged
  }
}

public extension SessionUnlockClient {
  /// Production binding. `reason` is the copy on the system
  /// authentication sheet ("<app> is trying to …").
  ///
  /// Two storage shapes exist (see `KeychainProtection.biometricWithDeviceFallback`):
  ///
  /// - **Biometric item** (passcode + enrolled biometry at write time):
  ///   evaluate `.deviceOwnerAuthenticationWithBiometrics` first — the
  ///   item's ACL is `.biometryCurrentSet`, which a passcode cannot
  ///   satisfy — then read the Keychain with that same authenticated
  ///   `LAContext` so the OS doesn't raise a second prompt.
  /// - **Fallback item** (Simulator / no passcode / no biometry at write
  ///   time): the bytes decrypt silently, so gate with whatever device
  ///   credential exists (`.deviceOwnerAuthentication`, biometry-first
  ///   with passcode fallback). A device with no credentials at all has
  ///   nothing to gate with and unlocks directly.
  static func live(
    keychain: KeychainStore,
    cache: SessionTokenCache,
    enrollment: BiometryEnrollmentMonitor,
    reason: String
  ) -> SessionUnlockClient {
    SessionUnlockClient(
      unlock: {
        let probe: KeychainStore.NonInteractiveRead
        do {
          probe = try keychain.nonInteractiveString(forAccount: TokenStore.AccountKey.refresh)
        } catch {
          return .invalid
        }

        switch probe {
        case .missing:
          return .invalid

        case .value(let token):
          let context = LAContext()
          var unused: NSError?
          guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &unused) else {
            await cache.setRefreshToken(token)
            enrollment.recordBaseline()
            return .unlocked
          }
          do {
            guard try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) else {
              return .canceled
            }
          } catch {
            return .canceled
          }
          await cache.setRefreshToken(token)
          enrollment.recordBaseline()
          return .unlocked

        case .requiresUserAuthentication:
          var context = LAContext()
          do {
            guard
              try await context.evaluatePolicy(
                .deviceOwnerAuthenticationWithBiometrics,
                localizedReason: reason
              )
            else {
              return .canceled
            }
          } catch let error as LAError where error.code == .biometryLockout {
            // Five failed scans lock biometry OS-wide; under a
            // biometrics-only policy every retry then fails instantly
            // with no system UI, so "try again" can never succeed. A
            // passcode success on `.deviceOwnerAuthentication` clears
            // the lockout — walk the user through it, then re-run the
            // biometric check the `.biometryCurrentSet` ACL demands.
            let recovery = LAContext()
            guard
              (try? await recovery.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) == true
            else {
              return .biometryLockedOut
            }
            let retried = LAContext()
            do {
              guard
                try await retried.evaluatePolicy(
                  .deviceOwnerAuthenticationWithBiometrics,
                  localizedReason: reason
                )
              else {
                return .biometryLockedOut
              }
            } catch {
              return .biometryLockedOut
            }
            context = retried
          } catch {
            // Cancel, biometry unavailable — both leave the stored
            // session intact, so stay on the lock screen. The "sign in
            // with a different account" escape hatch always remains.
            return .canceled
          }
          do {
            let token = try keychain.string(
              forAccount: TokenStore.AccountKey.refresh,
              authenticating: context
            )
            await cache.setRefreshToken(token)
            enrollment.recordBaseline()
            return .unlocked
          } catch {
            // The prompt passed but the bytes didn't come back —
            // `errSecItemNotFound` after a biometry re-enrollment is the
            // canonical case. The session is unrecoverable.
            return .invalid
          }
        }
      },
      invalidateSessionIfEnrollmentChanged: {
        guard enrollment.hasEnrollmentChanged() else { return false }
        // Drop the in-memory token before the caller dispatches the
        // sign-out teardown so not even one more silent refresh can use it.
        await cache.clear()
        return true
      }
    )
  }

  /// Composition-root footgun guard: like every other client here, the
  /// default is unwired. `.invalid` is deliberate — an unwired gate
  /// routes to login (loud, recoverable) instead of wedging the lock
  /// screen forever.
  static let unimplemented = SessionUnlockClient(
    unlock: { .invalid },
    invalidateSessionIfEnrollmentChanged: { false }
  )
}

private enum SessionUnlockClientKey: DependencyKey {
  static let liveValue: SessionUnlockClient = .unimplemented
  static let testValue: SessionUnlockClient = .unimplemented
}

public extension DependencyValues {
  var sessionUnlockClient: SessionUnlockClient {
    get { self[SessionUnlockClientKey.self] }
    set { self[SessionUnlockClientKey.self] = newValue }
  }
}
