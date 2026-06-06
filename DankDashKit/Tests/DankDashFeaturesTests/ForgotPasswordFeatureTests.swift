import XCTest
import ComposableArchitecture
import DankDashNetwork
@testable import DankDashFeatures

@MainActor
final class ForgotPasswordFeatureTests: XCTestCase {
  // MARK: - Request step (POST /v1/auth/forgot-password)

  func test_request_validEmail_advancesToRedeem() async {
    let store = TestStore(initialState: ForgotPasswordFeature.State()) {
      ForgotPasswordFeature()
    } withDependencies: {
      $0.authAPIClient.forgotPassword = { request in
        // The reducer lowercases before sending so the lookup hits the
        // citext column the account was created against.
        XCTAssertEqual(request.email, "user@example.com")
        return EmptyResponse()
      }
    }

    await store.send(.emailChanged("User@Example.com")) { $0.email = "User@Example.com" }
    await store.send(.submitTapped) { $0.isSubmitting = true }
    await store.receive(\.requestResponse.success) {
      $0.isSubmitting = false
      $0.step = .redeem
    }
  }

  func test_request_invalidEmail_isIgnored() async {
    // No stub: if the guard let the effect run, `.unimplemented` would throw.
    let store = TestStore(initialState: ForgotPasswordFeature.State(email: "bad")) {
      ForgotPasswordFeature()
    }

    await store.send(.submitTapped)  // guard rejects — no state change, no effect
  }

  func test_request_transportError_surfacesConnectionMessage() async {
    let store = TestStore(
      initialState: ForgotPasswordFeature.State(email: "user@example.com")
    ) {
      ForgotPasswordFeature()
    } withDependencies: {
      $0.authAPIClient.forgotPassword = { _ in
        throw APIError.transport(URLError(.notConnectedToInternet))
      }
    }

    await store.send(.submitTapped) { $0.isSubmitting = true }
    await store.receive(\.requestResponse.failure) {
      $0.isSubmitting = false
      $0.error = "We couldn't reach DankDash. Check your connection."
    }
  }

  // MARK: - Redeem step (POST /v1/auth/reset-password)

  func test_redeem_success_advancesToDone_andClearsSecrets() async {
    let initial = ForgotPasswordFeature.State(
      step: .redeem,
      email: "user@example.com",
      code: "ABCD-EFGH-JKMN",
      newPassword: "brandnewpass12"
    )
    let store = TestStore(initialState: initial) {
      ForgotPasswordFeature()
    } withDependencies: {
      $0.authAPIClient.resetPassword = { request in
        // The code is forwarded verbatim — the server normalizes it.
        XCTAssertEqual(request.code, "ABCD-EFGH-JKMN")
        XCTAssertEqual(request.newPassword, "brandnewpass12")
        return EmptyResponse()
      }
    }

    await store.send(.resetTapped) { $0.isSubmitting = true }
    await store.receive(\.resetResponse.success) {
      $0.isSubmitting = false
      $0.step = .done
      $0.code = ""
      $0.newPassword = ""
    }
  }

  func test_redeem_serverRejectsCode_surfacesServerMessage_staysOnRedeem() async {
    let envelope = ErrorEnvelope(
      error: .init(code: "TOKEN_INVALID", message: "That reset code is invalid or has expired.")
    )
    let initial = ForgotPasswordFeature.State(
      step: .redeem,
      email: "user@example.com",
      code: "ZZZZ-ZZZZ-ZZZZ",
      newPassword: "brandnewpass12"
    )
    let store = TestStore(initialState: initial) {
      ForgotPasswordFeature()
    } withDependencies: {
      $0.authAPIClient.resetPassword = { _ in
        throw APIError.server(status: 401, envelope: envelope)
      }
    }

    await store.send(.resetTapped) { $0.isSubmitting = true }
    await store.receive(\.resetResponse.failure) {
      $0.isSubmitting = false
      $0.error = "That reset code is invalid or has expired."
    }
    XCTAssertEqual(store.state.step, .redeem, "A rejected code keeps the user on the redeem step.")
  }

  func test_resetTapped_invalidInput_isIgnored() async {
    let store = TestStore(
      initialState: ForgotPasswordFeature.State(step: .redeem, code: "AB", newPassword: "x")
    ) {
      ForgotPasswordFeature()
    }

    await store.send(.resetTapped)  // guard rejects — code too short, password below policy
  }

  // MARK: - Validation gates

  func test_canRequest_trueOnlyWithValidEmailOnRequestStep() {
    var state = ForgotPasswordFeature.State(email: "user@example.com")
    XCTAssertTrue(state.canRequest)

    state.email = "nope"
    XCTAssertFalse(state.canRequest)

    state.email = "user@example.com"
    state.step = .redeem
    XCTAssertFalse(state.canRequest, "Request is one-shot — disabled once we advance.")

    state.step = .request
    state.isSubmitting = true
    XCTAssertFalse(state.canRequest)
  }

  func test_canRedeem_requiresFullCodeAndPasswordPolicy() {
    var state = ForgotPasswordFeature.State(
      step: .redeem,
      code: "ABCD-EFGH-JKMN",
      newPassword: "brandnewpass12"
    )
    XCTAssertTrue(state.canRedeem)

    state.newPassword = "short1"            // below the 12-char floor
    XCTAssertFalse(state.canRedeem)

    state.newPassword = "alllettersonly"    // no digit
    XCTAssertFalse(state.canRedeem)

    state.newPassword = "123456789012"      // no letter
    XCTAssertFalse(state.canRedeem)

    state.newPassword = "brandnewpass12"
    state.code = "ABCD"                      // fewer than 12 significant symbols
    XCTAssertFalse(state.canRedeem)
  }

  func test_codeIsValid_ignoresSeparatorsAndWhitespace() {
    var state = ForgotPasswordFeature.State(step: .redeem)
    state.code = "abcd efgh jkmn"
    XCTAssertTrue(state.codeIsValid)
    state.code = "ABCDEFGHJKMN"
    XCTAssertTrue(state.codeIsValid)
    state.code = "ABCD-EFGH"
    XCTAssertFalse(state.codeIsValid)
  }

  // MARK: - Dismissal

  func test_dismiss_emitsDelegate() async {
    let store = TestStore(initialState: ForgotPasswordFeature.State()) {
      ForgotPasswordFeature()
    }

    await store.send(.dismissTapped)
    await store.receive(\.delegate.dismissed)
  }
}
