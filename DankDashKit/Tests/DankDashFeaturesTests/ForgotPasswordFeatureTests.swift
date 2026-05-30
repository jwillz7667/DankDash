import XCTest
import ComposableArchitecture
@testable import DankDashFeatures

@MainActor
final class ForgotPasswordFeatureTests: XCTestCase {
  func test_submit_validEmail_marksSubmitted() async {
    let store = TestStore(initialState: ForgotPasswordFeature.State()) {
      ForgotPasswordFeature()
    }

    await store.send(.emailChanged("user@example.com")) { $0.email = "user@example.com" }
    await store.send(.submitTapped) { $0.submitted = true }
  }

  func test_submit_invalidEmail_isIgnored() async {
    let store = TestStore(initialState: ForgotPasswordFeature.State(email: "bad")) {
      ForgotPasswordFeature()
    }

    await store.send(.submitTapped)  // no state change — guard rejected
  }

  func test_canSubmit_blockedAfterSubmit() {
    var state = ForgotPasswordFeature.State(email: "user@example.com")
    XCTAssertTrue(state.canSubmit)
    state.submitted = true
    XCTAssertFalse(state.canSubmit, "Submit button stays disabled after confirmation lands.")
  }

  func test_dismiss_emitsDelegate() async {
    let store = TestStore(initialState: ForgotPasswordFeature.State()) {
      ForgotPasswordFeature()
    }

    await store.send(.dismissTapped)
    await store.receive(\.delegate.dismissed)
  }
}
