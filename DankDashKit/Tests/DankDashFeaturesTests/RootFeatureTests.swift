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

  func test_onAppear_withSession_routesStraightToSignedIn() async {
    // Persistent login: a stored session lands on signedIn with no unlock
    // gate — the user stays signed in across relaunches, no password / Face ID.
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

    await store.send(.ageGate(.confirmTapped))
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

  func test_signOut_clearsKeychain_disconnectsRealtime_resetsToAuth() async {
    let cleared = ClearedRecorder()
    let disconnected = ClearedRecorder()
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
      $0.realtimeClient.disconnect = { await disconnected.markCleared() }
    }

    await store.send(.signOutTapped) {
      $0.signedInUser = nil
      $0.login = .init()
      $0.signUp = .init()
      $0.forgotPassword = nil
      $0.authScreen = .login
      $0.screen = .auth
      $0.browse = .init()
    }
    await store.finish()

    let wasCleared = await cleared.value
    XCTAssertTrue(wasCleared, "TokenStore.clear must run on sign-out so future launches re-auth.")
    let wasDisconnected = await disconnected.value
    XCTAssertTrue(
      wasDisconnected,
      "Realtime socket must be torn down on sign-out — its reconnect replays the old user's JWT."
    )
  }

  func test_deepLinkReceived_orderComplete_stashesPendingRoute() async {
    let orderId = UUID(uuidString: "11111111-2222-3333-4444-555555555555")!
    let store = TestStore(initialState: RootFeature.State(screen: .signedIn)) {
      RootFeature()
    }

    let url = URL(string: "dankdash://order/complete?orderId=\(orderId.uuidString)")!
    await store.send(.deepLinkReceived(url)) {
      $0.pendingDeepLink = .orderComplete(orderId: orderId)
    }
  }

  func test_deepLinkReceived_unknownURL_isSilentlyIgnored() async {
    let store = TestStore(initialState: RootFeature.State(screen: .signedIn)) {
      RootFeature()
    }

    let url = URL(string: "https://example.com/somewhere")!
    await store.send(.deepLinkReceived(url))
  }

  func test_deepLinkReceived_malformedOrderId_isSilentlyIgnored() async {
    let store = TestStore(initialState: RootFeature.State(screen: .signedIn)) {
      RootFeature()
    }

    let url = URL(string: "dankdash://order/complete?orderId=not-a-uuid")!
    await store.send(.deepLinkReceived(url))
  }

  func test_deepLinkConsumed_clearsPendingRoute() async {
    let orderId = UUID()
    let store = TestStore(
      initialState: RootFeature.State(
        screen: .signedIn,
        pendingDeepLink: .orderComplete(orderId: orderId)
      )
    ) {
      RootFeature()
    }

    await store.send(.deepLinkConsumed) {
      $0.pendingDeepLink = nil
    }
  }

  func test_deepLinkReceived_duringBootstrap_survivesBootstrapResolution() async {
    let orderId = UUID()
    let store = TestStore(initialState: RootFeature.State()) {
      RootFeature()
    } withDependencies: {
      $0.tokenStore = TokenStore(
        loadAccess: { "access" },
        loadRefresh: { "refresh" },
        persist: { _ in },
        clear: {}
      )
    }

    let url = URL(string: "dankdash://order/complete?orderId=\(orderId.uuidString)")!
    await store.send(.deepLinkReceived(url)) {
      $0.pendingDeepLink = .orderComplete(orderId: orderId)
    }

    await store.send(.onAppear)
    await store.receive(\.bootstrapResolved) {
      $0.screen = .signedIn
    }

    XCTAssertEqual(store.state.pendingDeepLink, .orderComplete(orderId: orderId))
  }

  func test_signOut_clearsPendingDeepLink() async {
    let cleared = ClearedRecorder()
    let store = TestStore(
      initialState: RootFeature.State(
        screen: .signedIn,
        signedInUser: LoginFeatureTests.sampleUser,
        pendingDeepLink: .orderComplete(orderId: UUID())
      )
    ) {
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
      $0.browse = .init()
      $0.pendingDeepLink = nil
    }
    await store.finish()
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

  // MARK: - sign-out routed up from the Account tab

  func test_browseDelegateSignOutRequested_clearsKeychain_resetsToAuth() async {
    let cleared = ClearedRecorder()
    let disconnected = ClearedRecorder()
    let store = TestStore(initialState: RootFeature.State(
      screen: .signedIn,
      signedInUser: LoginFeatureTests.sampleUser,
      browse: BrowseFeature.State(selectedTab: .account)
    )) {
      RootFeature()
    } withDependencies: {
      $0.tokenStore = TokenStore(
        loadAccess: { nil },
        loadRefresh: { nil },
        persist: { _ in },
        clear: { await cleared.markCleared() }
      )
      $0.realtimeClient.disconnect = { await disconnected.markCleared() }
    }
    store.exhaustivity = .off

    await store.send(.browse(.delegate(.signOutRequested)))
    await store.finish()

    XCTAssertEqual(store.state.screen, .auth)
    XCTAssertNil(store.state.signedInUser)
    XCTAssertEqual(store.state.authScreen, .login)
    let wasCleared = await cleared.value
    XCTAssertTrue(wasCleared, "Account-tab sign-out must clear tokens just like the explicit CTA.")
    let wasDisconnected = await disconnected.value
    XCTAssertTrue(wasDisconnected, "Account-tab sign-out must tear the realtime socket down too.")
  }

  func test_browseDelegateAccountDeletionCompleted_clearsKeychain_resetsToAuth() async {
    let cleared = ClearedRecorder()
    let disconnected = ClearedRecorder()
    let store = TestStore(initialState: RootFeature.State(
      screen: .signedIn,
      signedInUser: LoginFeatureTests.sampleUser,
      browse: BrowseFeature.State(selectedTab: .account)
    )) {
      RootFeature()
    } withDependencies: {
      $0.tokenStore = TokenStore(
        loadAccess: { nil },
        loadRefresh: { nil },
        persist: { _ in },
        clear: { await cleared.markCleared() }
      )
      $0.realtimeClient.disconnect = { await disconnected.markCleared() }
    }
    store.exhaustivity = .off

    await store.send(.browse(.delegate(.accountDeletionCompleted)))
    await store.finish()

    XCTAssertEqual(store.state.screen, .auth)
    XCTAssertNil(store.state.signedInUser)
    XCTAssertEqual(store.state.authScreen, .login)
    let wasCleared = await cleared.value
    XCTAssertTrue(
      wasCleared,
      "Account deletion must clear tokens and reset to auth — the session is dead."
    )
    let wasDisconnected = await disconnected.value
    XCTAssertTrue(wasDisconnected, "Account deletion must tear the realtime socket down too.")
  }
}

private actor ClearedRecorder {
  var value = false

  func markCleared() {
    self.value = true
  }
}
