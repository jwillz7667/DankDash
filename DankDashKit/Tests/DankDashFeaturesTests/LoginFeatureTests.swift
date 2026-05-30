import XCTest
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

@MainActor
final class LoginFeatureTests: XCTestCase {
  func test_loginSuccess_persistsTokens_emitsDelegate() async {
    let user = Self.sampleUser
    let tokenPair = Self.sampleTokens
    let persistedTokens = TokensRecorder()

    let store = TestStore(
      initialState: LoginFeature.State(email: "User@Example.com", password: "longenough123")
    ) {
      LoginFeature()
    } withDependencies: {
      $0.authAPIClient = AuthAPIClient(
        login: { request in
          XCTAssertEqual(request.email, "user@example.com")
          XCTAssertEqual(request.password, "longenough123")
          return .authenticated(user: user, tokens: tokenPair)
        },
        register: { _ in throw APIError.configuration("not used") },
        verifyMfa: { _ in throw APIError.configuration("not used") }
      )
      $0.tokenStore = TokenStore(
        loadAccess: { nil },
        loadRefresh: { nil },
        persist: { tokens in await persistedTokens.set(tokens) },
        clear: {}
      )
    }

    await store.send(.loginTapped) { $0.isSubmitting = true }
    await store.receive(\.loginResponse.success) { $0.isSubmitting = false }
    await store.receive(\.delegate.authenticated)

    let captured = await persistedTokens.value
    XCTAssertEqual(captured, tokenPair, "Tokens persisted to keychain before delegate fired.")
  }

  func test_loginMfaRequired_advancesToMfaPrompt() async {
    let store = TestStore(
      initialState: LoginFeature.State(email: "user@example.com", password: "longenough123")
    ) {
      LoginFeature()
    } withDependencies: {
      $0.authAPIClient = AuthAPIClient(
        login: { _ in
          .mfaRequired(challengeId: "chal_abc123", challengeExpiresAt: "2026-05-20T13:00:00Z")
        },
        register: { _ in throw APIError.configuration("not used") },
        verifyMfa: { _ in throw APIError.configuration("not used") }
      )
      $0.tokenStore = .inMemory
    }

    await store.send(.loginTapped) { $0.isSubmitting = true }
    await store.receive(\.loginResponse.success) {
      $0.isSubmitting = false
      $0.mfaChallengeId = "chal_abc123"
      $0.mfaCode = ""
    }
  }

  func test_loginUnauthorized_setsFriendlyError() async {
    let store = TestStore(
      initialState: LoginFeature.State(email: "user@example.com", password: "longenough123")
    ) {
      LoginFeature()
    } withDependencies: {
      $0.authAPIClient = AuthAPIClient(
        login: { _ in throw APIError.unauthorized },
        register: { _ in throw APIError.configuration("not used") },
        verifyMfa: { _ in throw APIError.configuration("not used") }
      )
      $0.tokenStore = .inMemory
    }

    await store.send(.loginTapped) { $0.isSubmitting = true }
    await store.receive(\.loginResponse.failure) {
      $0.isSubmitting = false
      $0.error = "Email or password is incorrect."
    }
  }

  func test_loginServerError_surfacesServerMessage() async {
    let envelope = ErrorEnvelope(error: .init(
      code: "ACCOUNT_LOCKED",
      message: "Your account is locked. Reset your password."
    ))

    let store = TestStore(
      initialState: LoginFeature.State(email: "user@example.com", password: "longenough123")
    ) {
      LoginFeature()
    } withDependencies: {
      $0.authAPIClient = AuthAPIClient(
        login: { _ in throw APIError.server(status: 423, envelope: envelope) },
        register: { _ in throw APIError.configuration("not used") },
        verifyMfa: { _ in throw APIError.configuration("not used") }
      )
      $0.tokenStore = .inMemory
    }

    await store.send(.loginTapped) { $0.isSubmitting = true }
    await store.receive(\.loginResponse.failure) {
      $0.isSubmitting = false
      $0.error = "Your account is locked. Reset your password."
    }
  }

  func test_mfaVerifySuccess_persistsTokens_emitsDelegate() async {
    let user = Self.sampleUser
    let tokenPair = Self.sampleTokens
    let persistedTokens = TokensRecorder()

    let store = TestStore(
      initialState: LoginFeature.State(
        email: "user@example.com",
        password: "longenough123",
        mfaChallengeId: "chal_abc123"
      )
    ) {
      LoginFeature()
    } withDependencies: {
      $0.authAPIClient = AuthAPIClient(
        login: { _ in throw APIError.configuration("not used") },
        register: { _ in throw APIError.configuration("not used") },
        verifyMfa: { request in
          XCTAssertEqual(request.challengeId, "chal_abc123")
          XCTAssertEqual(request.code, "123456")
          return MfaVerifyResponseDTO(user: user, tokens: tokenPair)
        }
      )
      $0.tokenStore = TokenStore(
        loadAccess: { nil },
        loadRefresh: { nil },
        persist: { tokens in await persistedTokens.set(tokens) },
        clear: {}
      )
    }

    await store.send(.mfaCodeChanged("123456")) { $0.mfaCode = "123456" }
    await store.send(.mfaVerifyTapped) { $0.isSubmitting = true }
    await store.receive(\.mfaResponse.success) { $0.isSubmitting = false }
    await store.receive(\.delegate.authenticated)

    let captured = await persistedTokens.value
    XCTAssertEqual(captured, tokenPair)
  }

  func test_mfaCodeChanged_stripsNonDigits() async {
    let store = TestStore(
      initialState: LoginFeature.State(mfaChallengeId: "chal_abc")
    ) {
      LoginFeature()
    }

    await store.send(.mfaCodeChanged("12a3-4 5b6")) { $0.mfaCode = "123456" }
  }

  func test_canSubmit_requiresValidEmailAndPassword() {
    var state = LoginFeature.State()
    XCTAssertFalse(state.canSubmit)
    state.email = "bad"
    state.password = "secret"
    XCTAssertFalse(state.canSubmit, "Invalid email blocks submit.")
    state.email = "user@example.com"
    XCTAssertTrue(state.canSubmit, "Valid email + non-empty password allows submit.")
    state.password = ""
    XCTAssertFalse(state.canSubmit, "Empty password blocks submit.")
  }

  static let sampleUser = UserSummaryDTO(
    id: "0192d6e3-3a90-7c11-a000-000000000001",
    email: "user@example.com",
    phone: nil,
    firstName: "Alex",
    lastName: "Customer",
    role: "customer",
    status: "active",
    kycVerified: false,
    mfaEnabled: false,
    createdAt: "2026-05-01T00:00:00Z"
  )

  static let sampleTokens = TokenPairDTO(
    accessToken: "access.jwt",
    refreshToken: "refresh.opaque",
    accessTokenExpiresAt: "2026-05-20T13:00:00Z",
    refreshTokenExpiresAt: "2026-06-20T13:00:00Z"
  )
}

/// Captures the most recently persisted token pair from the TokenStore
/// stub so the assertion can run after the effect completes.
private actor TokensRecorder {
  var value: TokenPairDTO?

  func set(_ tokens: TokenPairDTO) {
    self.value = tokens
  }
}
