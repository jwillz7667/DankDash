import XCTest
import ComposableArchitecture
@testable import DankDashFeatures

@MainActor
final class AgeGateFeatureTests: XCTestCase {
  func test_confirm_passesGate() async {
    let store = TestStore(initialState: AgeGateFeature.State()) {
      AgeGateFeature()
    }

    await store.send(.confirmTapped)
    await store.receive(\.delegate.passed)
  }

  func test_decline_setsError_doesNotPass() async {
    let store = TestStore(initialState: AgeGateFeature.State()) {
      AgeGateFeature()
    }

    await store.send(.declineTapped) {
      $0.error = "You must be 21 or older to use DankDash."
    }
  }

  func test_confirm_clearsPriorDeclineError() async {
    let store = TestStore(
      initialState: AgeGateFeature.State(error: "You must be 21 or older to use DankDash.")
    ) {
      AgeGateFeature()
    }

    await store.send(.confirmTapped) {
      $0.error = nil
    }
    await store.receive(\.delegate.passed)
  }
}
