import Foundation
import ComposableArchitecture

/// Launch-time session gate. Shown when bootstrap finds a stored session:
/// the user must pass Face ID / device authentication once before the app
/// unlocks, after which all token refreshes are silent (see
/// ``SessionUnlockClient``). The reducer auto-attempts on appear so the
/// happy path is a single Face ID glance with no taps.
@Reducer
public struct SessionLockFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable {
    public var isUnlocking: Bool
    public var failureMessage: String?
    /// The on-appear auto-attempt must fire exactly once per lock-screen
    /// presentation — SwiftUI can re-run `.task` (tab restoration, view
    /// identity churn) and a second implicit prompt would be hostile.
    public var hasAutoAttempted: Bool

    public init(
      isUnlocking: Bool = false,
      failureMessage: String? = nil,
      hasAutoAttempted: Bool = false
    ) {
      self.isUnlocking = isUnlocking
      self.failureMessage = failureMessage
      self.hasAutoAttempted = hasAutoAttempted
    }
  }

  public enum Action: Equatable, Sendable {
    case onAppear
    case unlockTapped
    case signOutTapped
    case unlockResponse(SessionUnlockOutcome)
    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Equatable, Sendable {
      /// The refresh token is decrypted and cached — route to signed-in.
      case unlocked
      /// The stored session is unrecoverable (item gone or invalidated by
      /// biometry re-enrollment) — the parent must clear it and show login.
      case sessionInvalidated
      /// Explicit "sign in with a different account" escape hatch.
      case signOutRequested
    }
  }

  @Dependency(\.sessionUnlockClient) var sessionUnlock

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .onAppear:
        guard !state.hasAutoAttempted, !state.isUnlocking else { return .none }
        state.hasAutoAttempted = true
        state.isUnlocking = true
        state.failureMessage = nil
        return runUnlock()

      case .unlockTapped:
        guard !state.isUnlocking else { return .none }
        state.isUnlocking = true
        state.failureMessage = nil
        return runUnlock()

      case .unlockResponse(.unlocked):
        state.isUnlocking = false
        return .send(.delegate(.unlocked))

      case .unlockResponse(.canceled):
        state.isUnlocking = false
        state.failureMessage =
          "Face ID didn't complete. Try again, or sign in with your email and password."
        return .none

      case .unlockResponse(.biometryLockedOut):
        // A plain "try again" is a lie here — biometry is OS-locked and
        // only the device passcode re-enables it. Tapping Unlock runs the
        // passcode recovery flow in ``SessionUnlockClient``.
        state.isUnlocking = false
        state.failureMessage =
          "Face ID is locked after too many attempts. Tap Unlock to enter your iPhone passcode, or sign in with your email and password."
        return .none

      case .unlockResponse(.invalid):
        state.isUnlocking = false
        return .send(.delegate(.sessionInvalidated))

      case .signOutTapped:
        return .send(.delegate(.signOutRequested))

      case .delegate:
        return .none
      }
    }
  }

  private func runUnlock() -> Effect<Action> {
    .run { send in
      await send(.unlockResponse(await sessionUnlock.unlock()))
    }
  }
}
