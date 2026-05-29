import XCTest
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

@MainActor
final class SignUpFeatureTests: XCTestCase {
  func test_submit_validatesEachField_whenAllInvalid() async {
    let store = TestStore(initialState: SignUpFeature.State()) {
      SignUpFeature()
    } withDependencies: {
      $0.authAPIClient = .unimplemented
      $0.tokenStore = .inMemory
    }

    await store.send(.submitTapped) {
      $0.fieldErrors = SignUpFeature.State.FieldErrors(
        firstName: "Enter your first name.",
        lastName: "Enter your last name.",
        email: "Enter a valid email address.",
        phone: nil,
        password: "Password must be 12+ characters and include a letter and a digit.",
        dateOfBirth: "Enter your date of birth."
      )
    }
  }

  func test_submit_validatesPhoneFormat_whenProvided() async {
    let store = TestStore(initialState: SignUpFeature.State(
      firstName: "Alex",
      lastName: "Customer",
      email: "user@example.com",
      phone: "555-1212",
      password: "longenough123",
      dateOfBirth: DateOfBirth(year: 2000, month: 1, day: 1)
    )) {
      SignUpFeature()
    } withDependencies: {
      $0.authAPIClient = .unimplemented
      $0.tokenStore = .inMemory
    }

    await store.send(.submitTapped) {
      $0.fieldErrors = SignUpFeature.State.FieldErrors(
        phone: "Phone must be in E.164 format (e.g. +14155551234)."
      )
    }
  }

  func test_submit_validInput_persistsTokens_emitsDelegate() async {
    let user = LoginFeatureTests.sampleUser
    let tokens = LoginFeatureTests.sampleTokens
    let persisted = TokensRecorder()

    let store = TestStore(initialState: SignUpFeature.State(
      firstName: "  Alex  ",
      lastName: "Customer",
      email: "User@Example.com",
      phone: "+14155551234",
      password: "longenough123",
      dateOfBirth: DateOfBirth(year: 2000, month: 5, day: 1)
    )) {
      SignUpFeature()
    } withDependencies: {
      $0.authAPIClient = AuthAPIClient(
        login: { _ in throw APIError.configuration("not used") },
        register: { request in
          XCTAssertEqual(request.firstName, "Alex", "firstName trimmed before posting.")
          XCTAssertEqual(request.email, "user@example.com", "email lowercased before posting.")
          XCTAssertEqual(request.phone, "+14155551234")
          XCTAssertEqual(request.dateOfBirth, "2000-05-01")
          XCTAssertEqual(request.password, "longenough123")
          return RegisterResponseDTO(user: user, tokens: tokens)
        },
        verifyMfa: { _ in throw APIError.configuration("not used") }
      )
      $0.tokenStore = TokenStore(
        loadAccess: { nil },
        loadRefresh: { nil },
        persist: { t in await persisted.set(t) },
        clear: {}
      )
    }

    await store.send(.submitTapped) { $0.isSubmitting = true }
    await store.receive(\.registerResponse.success) { $0.isSubmitting = false }
    await store.receive(\.delegate.registered)

    let captured = await persisted.value
    XCTAssertEqual(captured, tokens)
  }

  func test_submit_serverError_surfacesServerMessage() async {
    let envelope = ErrorEnvelope(error: .init(
      code: "EMAIL_TAKEN",
      message: "That email is already in use."
    ))

    let store = TestStore(initialState: SignUpFeature.State(
      firstName: "Alex",
      lastName: "Customer",
      email: "user@example.com",
      password: "longenough123",
      dateOfBirth: DateOfBirth(year: 2000, month: 5, day: 1)
    )) {
      SignUpFeature()
    } withDependencies: {
      $0.authAPIClient = AuthAPIClient(
        login: { _ in throw APIError.configuration("not used") },
        register: { _ in throw APIError.server(status: 409, envelope: envelope) },
        verifyMfa: { _ in throw APIError.configuration("not used") }
      )
      $0.tokenStore = .inMemory
    }

    await store.send(.submitTapped) { $0.isSubmitting = true }
    await store.receive(\.registerResponse.failure) {
      $0.isSubmitting = false
      $0.error = "That email is already in use."
    }
  }

  func test_passwordPolicy() {
    XCTAssertFalse(SignUpFeature.passwordSatisfiesPolicy("short"))
    XCTAssertFalse(SignUpFeature.passwordSatisfiesPolicy("nodigitssss"))
    XCTAssertFalse(SignUpFeature.passwordSatisfiesPolicy("111111111111"), "digits only must fail")
    XCTAssertTrue(SignUpFeature.passwordSatisfiesPolicy("aaaaaaaaaaa1"))
    XCTAssertTrue(SignUpFeature.passwordSatisfiesPolicy("Password1234"))
  }
}

private actor TokensRecorder {
  var value: TokenPairDTO?

  func set(_ tokens: TokenPairDTO) {
    self.value = tokens
  }
}
