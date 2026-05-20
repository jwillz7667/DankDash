import XCTest
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

@MainActor
final class RootFeatureTests: XCTestCase {
  func test_onAppear_withoutSession_routesToAgeGate() async {
    let store = TestStore(initialState: RootFeature.State()) {
      RootFeature()
    } withDependencies: {
      $0.tokenStore = TokenStore(
        loadAccess: { nil },
        loadRefresh: { nil },
        persist: { _ in },
        clear: {}
      )
    }

    await store.send(.onAppear)
    await store.receive(\.bootstrapResolved) {
      $0.screen = .ageGate
    }
  }

  func test_onAppear_withSession_routesToSignedIn() async {
    let store = TestStore(initialState: RootFeature.State()) {
      RootFeature()
    } withDependencies: {
      $0.tokenStore = TokenStore(
        loadAccess: { "access.jwt" },
        loadRefresh: { "refresh.opaque" },
        persist: { _ in },
        clear: {}
      )
    }

    await store.send(.onAppear)
    await store.receive(\.bootstrapResolved) {
      $0.screen = .signedIn
    }
  }

  func test_ageGatePassed_routesToAuth() async {
    let store = TestStore(initialState: RootFeature.State(screen: .ageGate)) {
      RootFeature()
    } withDependencies: {
      $0.date.now = Self.referenceDate
      $0.tokenStore = .inMemory
    }

    await store.send(.ageGate(.monthChanged(5))) { $0.ageGate.month = 5 }
    await store.send(.ageGate(.dayChanged(20))) { $0.ageGate.day = 20 }
    await store.send(.ageGate(.yearChanged(2000))) { $0.ageGate.year = 2000 }
    await store.send(.ageGate(.acknowledgementToggled(true))) { $0.ageGate.acknowledged = true }
    await store.send(.ageGate(.submitTapped))
    await store.receive(\.ageGate.delegate.passed) {
      $0.screen = .auth
    }
  }

  func test_loginAuthenticated_routesToSignedIn() async {
    let user = LoginFeatureTests.sampleUser
    let tokens = LoginFeatureTests.sampleTokens

    let store = TestStore(initialState: RootFeature.State(
      screen: .auth,
      login: LoginFeature.State(email: "user@example.com", password: "longenough123")
    )) {
      RootFeature()
    } withDependencies: {
      $0.authAPIClient = AuthAPIClient(
        login: { _ in .authenticated(user: user, tokens: tokens) },
        register: { _ in throw APIError.configuration("not used") },
        verifyMfa: { _ in throw APIError.configuration("not used") }
      )
      $0.tokenStore = .inMemory
    }

    await store.send(.login(.loginTapped)) { $0.login.isSubmitting = true }
    await store.receive(\.login.loginResponse.success) { $0.login.isSubmitting = false }
    await store.receive(\.login.delegate.authenticated) {
      $0.signedInUser = user
      $0.screen = .signedIn
    }
  }

  func test_signUpRegistered_routesToSignedIn() async {
    let user = LoginFeatureTests.sampleUser
    let tokens = LoginFeatureTests.sampleTokens

    let store = TestStore(initialState: RootFeature.State(
      screen: .auth,
      signUp: SignUpFeature.State(
        firstName: "Alex",
        lastName: "Customer",
        email: "user@example.com",
        password: "longenough123",
        dateOfBirth: DateOfBirth(year: 2000, month: 5, day: 1)
      )
    )) {
      RootFeature()
    } withDependencies: {
      $0.authAPIClient = AuthAPIClient(
        login: { _ in throw APIError.configuration("not used") },
        register: { _ in RegisterResponseDTO(user: user, tokens: tokens) },
        verifyMfa: { _ in throw APIError.configuration("not used") }
      )
      $0.tokenStore = .inMemory
    }

    await store.send(.signUp(.submitTapped)) { $0.signUp.isSubmitting = true }
    await store.receive(\.signUp.registerResponse.success) { $0.signUp.isSubmitting = false }
    await store.receive(\.signUp.delegate.registered) {
      $0.signedInUser = user
      $0.screen = .signedIn
    }
  }

  func test_forgotPasswordTapped_seedsEmailFromLogin() async {
    let store = TestStore(initialState: RootFeature.State(
      screen: .auth,
      login: LoginFeature.State(email: "carry-over@example.com")
    )) {
      RootFeature()
    } withDependencies: {
      $0.tokenStore = .inMemory
    }

    await store.send(.authForgotPasswordTapped) {
      $0.authScreen = .forgotPassword
      $0.forgotPassword = ForgotPasswordFeature.State(email: "carry-over@example.com")
    }
  }

  func test_forgotPasswordDismissed_clearsAndReturnsToLogin() async {
    let store = TestStore(initialState: RootFeature.State(
      screen: .auth,
      forgotPassword: ForgotPasswordFeature.State(email: "user@example.com"),
      authScreen: .forgotPassword
    )) {
      RootFeature()
    } withDependencies: {
      $0.tokenStore = .inMemory
    }

    await store.send(.forgotPassword(.dismissTapped))
    await store.receive(\.forgotPassword.delegate.dismissed) {
      $0.forgotPassword = nil
      $0.authScreen = .login
    }
  }

  func test_signOut_clearsKeychain_resetsToAuth() async {
    let cleared = ClearedRecorder()
    let store = TestStore(initialState: RootFeature.State(
      screen: .signedIn,
      login: LoginFeature.State(email: "user@example.com", password: "secret"),
      signedInUser: LoginFeatureTests.sampleUser
    )) {
      RootFeature()
    } withDependencies: {
      $0.tokenStore = TokenStore(
        loadAccess: { nil },
        loadRefresh: { nil },
        persist: { _ in },
        clear: { await cleared.markCleared() }
      )
    }

    await store.send(.signOutTapped) {
      $0.signedInUser = nil
      $0.login = .init()
      $0.signUp = .init()
      $0.forgotPassword = nil
      $0.authScreen = .login
      $0.screen = .auth
    }
    await store.finish()

    let wasCleared = await cleared.value
    XCTAssertTrue(wasCleared, "TokenStore.clear must run on sign-out so future launches re-auth.")
  }

  static let referenceDate: Date = {
    var components = DateComponents()
    components.year = 2026
    components.month = 5
    components.day = 20
    components.hour = 12
    components.timeZone = TimeZone(identifier: "America/Chicago")
    return Calendar(identifier: .gregorian).date(from: components)!
  }()
}

private actor ClearedRecorder {
  var value = false

  func markCleared() {
    self.value = true
  }
}
