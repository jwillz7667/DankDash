import XCTest
import ComposableArchitecture
@testable import DankDashFeatures

@MainActor
final class SessionLockFeatureTests: XCTestCase {
  func test_onAppear_autoAttempts_andDelegatesUnlocked() async {
    let store = TestStore(initialState: SessionLockFeature.State()) {
      SessionLockFeature()
    } withDependencies: {
      $0.sessionUnlockClient = SessionUnlockClient(unlock: { .unlocked })
    }

    await store.send(.onAppear) {
      $0.hasAutoAttempted = true
      $0.isUnlocking = true
    }
    await store.receive(\.unlockResponse) {
      $0.isUnlocking = false
    }
    await store.receive(\.delegate.unlocked)
  }

  func test_onAppear_secondFire_isNoOp() async {
    // SwiftUI can re-run `.task` on view identity churn — the auto
    // attempt must not raise a second Face ID sheet.
    let attempts = AttemptCounter()
    let store = TestStore(initialState: SessionLockFeature.State()) {
      SessionLockFeature()
    } withDependencies: {
      $0.sessionUnlockClient = SessionUnlockClient(unlock: {
        await attempts.increment()
        return .canceled
      })
    }

    await store.send(.onAppear) {
      $0.hasAutoAttempted = true
      $0.isUnlocking = true
    }
    await store.receive(\.unlockResponse) {
      $0.isUnlocking = false
      $0.failureMessage =
        "Face ID didn't complete. Try again, or sign in with your email and password."
    }

    await store.send(.onAppear)

    let count = await attempts.value
    XCTAssertEqual(count, 1, "the on-appear auto-attempt fires exactly once")
  }

  func test_canceled_thenRetry_unlocks() async {
    let outcomes = OutcomeQueue(outcomes: [.canceled, .unlocked])
    let store = TestStore(initialState: SessionLockFeature.State()) {
      SessionLockFeature()
    } withDependencies: {
      $0.sessionUnlockClient = SessionUnlockClient(unlock: { await outcomes.next() })
    }

    await store.send(.onAppear) {
      $0.hasAutoAttempted = true
      $0.isUnlocking = true
    }
    await store.receive(\.unlockResponse) {
      $0.isUnlocking = false
      $0.failureMessage =
        "Face ID didn't complete. Try again, or sign in with your email and password."
    }

    await store.send(.unlockTapped) {
      $0.isUnlocking = true
      $0.failureMessage = nil
    }
    await store.receive(\.unlockResponse) {
      $0.isUnlocking = false
    }
    await store.receive(\.delegate.unlocked)
  }

  func test_unlockTapped_whileUnlocking_isNoOp() async {
    let store = TestStore(
      initialState: SessionLockFeature.State(isUnlocking: true, hasAutoAttempted: true)
    ) {
      SessionLockFeature()
    }

    await store.send(.unlockTapped)
  }

  func test_biometryLockedOut_showsPasscodeGuidance_andStaysRetryable() async {
    // Lockout is NOT a plain cancel: "try again" can never succeed until
    // the passcode re-enables biometry, so the copy must say so — and the
    // screen must stay up (no delegate) so the retry runs the passcode
    // recovery flow.
    let outcomes = OutcomeQueue(outcomes: [.biometryLockedOut, .unlocked])
    let store = TestStore(initialState: SessionLockFeature.State()) {
      SessionLockFeature()
    } withDependencies: {
      $0.sessionUnlockClient = SessionUnlockClient(unlock: { await outcomes.next() })
    }

    await store.send(.onAppear) {
      $0.hasAutoAttempted = true
      $0.isUnlocking = true
    }
    await store.receive(\.unlockResponse) {
      $0.isUnlocking = false
      $0.failureMessage =
        "Face ID is locked after too many attempts. Tap Unlock to enter your iPhone passcode, or sign in with your email and password."
    }

    await store.send(.unlockTapped) {
      $0.isUnlocking = true
      $0.failureMessage = nil
    }
    await store.receive(\.unlockResponse) {
      $0.isUnlocking = false
    }
    await store.receive(\.delegate.unlocked)
  }

  func test_invalid_delegatesSessionInvalidated() async {
    let store = TestStore(initialState: SessionLockFeature.State()) {
      SessionLockFeature()
    } withDependencies: {
      $0.sessionUnlockClient = SessionUnlockClient(unlock: { .invalid })
    }

    await store.send(.onAppear) {
      $0.hasAutoAttempted = true
      $0.isUnlocking = true
    }
    await store.receive(\.unlockResponse) {
      $0.isUnlocking = false
    }
    await store.receive(\.delegate.sessionInvalidated)
  }

  func test_signOutTapped_delegatesSignOutRequested() async {
    let store = TestStore(
      initialState: SessionLockFeature.State(hasAutoAttempted: true)
    ) {
      SessionLockFeature()
    }

    await store.send(.signOutTapped)
    await store.receive(\.delegate.signOutRequested)
  }
}

private actor AttemptCounter {
  var value = 0

  func increment() {
    value += 1
  }
}

/// FIFO of scripted unlock outcomes so a test can model "cancel, then
/// succeed on retry" with one client stub.
private actor OutcomeQueue {
  private var outcomes: [SessionUnlockOutcome]

  init(outcomes: [SessionUnlockOutcome]) {
    self.outcomes = outcomes
  }

  func next() -> SessionUnlockOutcome {
    outcomes.isEmpty ? .invalid : outcomes.removeFirst()
  }
}
