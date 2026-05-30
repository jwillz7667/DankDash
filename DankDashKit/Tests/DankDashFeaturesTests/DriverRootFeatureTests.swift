import XCTest
import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

@MainActor
final class DriverRootFeatureTests: XCTestCase {

  // MARK: - Bootstrap

  func test_onAppear_noSession_landsOnAgeGate() async {
    let store = TestStore(initialState: DriverRootFeature.State()) {
      DriverRootFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
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

  func test_onAppear_withSession_driverPassed_landsOnShift() async {
    let driver = Self.passedDriver()
    let store = TestStore(initialState: DriverRootFeature.State()) {
      DriverRootFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.tokenStore = TokenStore(
        loadAccess: { "access" },
        loadRefresh: { "refresh" },
        persist: { _ in },
        clear: {}
      )
      $0.driverAppAPIClient = DriverAppAPIClient(
        getMe: { driver },
        getCurrentRoute: { throw DriverAPIError.unimplemented("getCurrentRoute") },
        getEarnings: { _ in throw DriverAPIError.unimplemented("getEarnings") },
        getShifts: { throw DriverAPIError.unimplemented("getShifts") }
      )
    }
    store.exhaustivity = .off

    await store.send(.onAppear)
    await store.skipReceivedActions()
    XCTAssertEqual(store.state.screen, .shift)
    XCTAssertEqual(store.state.driver, driver)
    XCTAssertEqual(store.state.shift.driver, driver)
  }

  func test_onAppear_withSession_driverPending_landsOnOnboarding() async {
    let pending = Self.passedDriver(backgroundCheckPassedAt: nil)
    let store = TestStore(initialState: DriverRootFeature.State()) {
      DriverRootFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.tokenStore = TokenStore(
        loadAccess: { "access" },
        loadRefresh: { "refresh" },
        persist: { _ in },
        clear: {}
      )
      $0.driverAppAPIClient = DriverAppAPIClient(
        getMe: { pending },
        getCurrentRoute: { throw DriverAPIError.unimplemented("getCurrentRoute") },
        getEarnings: { _ in throw DriverAPIError.unimplemented("getEarnings") },
        getShifts: { throw DriverAPIError.unimplemented("getShifts") }
      )
    }
    store.exhaustivity = .off

    await store.send(.onAppear)
    await store.skipReceivedActions()
    XCTAssertEqual(store.state.screen, .onboarding)
    XCTAssertEqual(store.state.driver, pending)
    XCTAssertEqual(store.state.onboarding.driver, pending)
  }

  func test_onAppear_withSession_endpoint404_landsOnOnboardingWithNoDriver() async {
    let store = TestStore(initialState: DriverRootFeature.State()) {
      DriverRootFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.tokenStore = TokenStore(
        loadAccess: { "access" },
        loadRefresh: { "refresh" },
        persist: { _ in },
        clear: {}
      )
      $0.driverAppAPIClient = DriverAppAPIClient(
        getMe: { throw DriverAppAPIError.endpointNotYetAvailable },
        getCurrentRoute: { throw DriverAPIError.unimplemented("getCurrentRoute") },
        getEarnings: { _ in throw DriverAPIError.unimplemented("getEarnings") },
        getShifts: { throw DriverAPIError.unimplemented("getShifts") }
      )
    }
    store.exhaustivity = .off

    await store.send(.onAppear)
    await store.skipReceivedActions()
    XCTAssertEqual(store.state.screen, .onboarding)
    XCTAssertNil(store.state.driver, "404 means no driver record yet")
  }

  func test_onAppear_withSession_serverFailure_keepsLoadingDriverWithBanner() async {
    let envelope = ErrorEnvelope(error: .init(code: "INTERNAL", message: "Down for maintenance"))
    let store = TestStore(initialState: DriverRootFeature.State()) {
      DriverRootFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.tokenStore = TokenStore(
        loadAccess: { "access" },
        loadRefresh: { "refresh" },
        persist: { _ in },
        clear: {}
      )
      $0.driverAppAPIClient = DriverAppAPIClient(
        getMe: { throw APIError.server(status: 500, envelope: envelope) },
        getCurrentRoute: { throw DriverAPIError.unimplemented("getCurrentRoute") },
        getEarnings: { _ in throw DriverAPIError.unimplemented("getEarnings") },
        getShifts: { throw DriverAPIError.unimplemented("getShifts") }
      )
    }
    store.exhaustivity = .off

    await store.send(.onAppear)
    await store.skipReceivedActions()
    XCTAssertEqual(store.state.screen, .loadingDriver, "real failure pins us on the loading screen so retry stays visible")
    XCTAssertEqual(store.state.driverLoadError, "Down for maintenance")
  }

  // MARK: - Age gate -> Auth

  func test_ageGatePassed_routesToAuth() async {
    let store = TestStore(initialState: DriverRootFeature.State(screen: .ageGate)) {
      DriverRootFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.ageGate(.delegate(.passed))) {
      $0.screen = .auth
    }
  }

  // MARK: - Auth screen toggles

  func test_authScreenSelected_swapsBetweenLoginAndSignUp() async {
    let store = TestStore(initialState: DriverRootFeature.State(screen: .auth)) {
      DriverRootFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.authSignUpScreenSelected) {
      $0.authScreen = .signUp
    }
    await store.send(.authLoginScreenSelected) {
      $0.authScreen = .login
    }
  }

  func test_authForgotPasswordTapped_pushesForgotPassword() async {
    let store = TestStore(
      initialState: DriverRootFeature.State(
        screen: .auth,
        login: LoginFeature.State(email: "driver@dankdash.com")
      )
    ) {
      DriverRootFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.authForgotPasswordTapped) {
      $0.authScreen = .forgotPassword
      $0.forgotPassword = ForgotPasswordFeature.State(email: "driver@dankdash.com")
    }
  }

  func test_forgotPasswordDismissed_clearsAndReturnsToLogin() async {
    let store = TestStore(
      initialState: DriverRootFeature.State(
        screen: .auth,
        forgotPassword: ForgotPasswordFeature.State(email: "driver@dankdash.com"),
        authScreen: .forgotPassword
      )
    ) {
      DriverRootFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.forgotPassword(.delegate(.dismissed))) {
      $0.forgotPassword = nil
      $0.authScreen = .login
    }
  }

  // MARK: - Login / sign-up success path

  func test_loginAuthenticated_loadsDriverAndRoutesToShift() async {
    let user = Self.user()
    let tokens = Self.tokens()
    let driver = Self.passedDriver()
    let store = TestStore(initialState: DriverRootFeature.State(screen: .auth)) {
      DriverRootFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverAppAPIClient = DriverAppAPIClient(
        getMe: { driver },
        getCurrentRoute: { throw DriverAPIError.unimplemented("getCurrentRoute") },
        getEarnings: { _ in throw DriverAPIError.unimplemented("getEarnings") },
        getShifts: { throw DriverAPIError.unimplemented("getShifts") }
      )
    }
    store.exhaustivity = .off

    await store.send(.login(.delegate(.authenticated(user: user, tokens: tokens))))
    await store.skipReceivedActions()
    XCTAssertEqual(store.state.signedInUser, user)
    XCTAssertEqual(store.state.screen, .shift)
    XCTAssertEqual(store.state.driver, driver)
  }

  func test_signUpRegistered_loadsDriverAndRoutesToOnboarding() async {
    let user = Self.user()
    let tokens = Self.tokens()
    let store = TestStore(initialState: DriverRootFeature.State(screen: .auth, authScreen: .signUp)) {
      DriverRootFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverAppAPIClient = DriverAppAPIClient(
        getMe: { throw DriverAppAPIError.endpointNotYetAvailable },
        getCurrentRoute: { throw DriverAPIError.unimplemented("getCurrentRoute") },
        getEarnings: { _ in throw DriverAPIError.unimplemented("getEarnings") },
        getShifts: { throw DriverAPIError.unimplemented("getShifts") }
      )
    }
    store.exhaustivity = .off

    await store.send(.signUp(.delegate(.registered(user: user, tokens: tokens))))
    await store.skipReceivedActions()
    XCTAssertEqual(store.state.signedInUser, user)
    XCTAssertEqual(store.state.screen, .onboarding, "new signup with no driver record routes to onboarding")
  }

  // MARK: - Retry

  func test_driverLoadRetryTapped_refetches() async {
    let driver = Self.passedDriver()
    let store = TestStore(
      initialState: DriverRootFeature.State(
        screen: .loadingDriver,
        driverLoadError: "Down for maintenance"
      )
    ) {
      DriverRootFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverAppAPIClient = DriverAppAPIClient(
        getMe: { driver },
        getCurrentRoute: { throw DriverAPIError.unimplemented("getCurrentRoute") },
        getEarnings: { _ in throw DriverAPIError.unimplemented("getEarnings") },
        getShifts: { throw DriverAPIError.unimplemented("getShifts") }
      )
    }
    store.exhaustivity = .off

    await store.send(.driverLoadRetryTapped) {
      $0.driverLoadError = nil
    }
    await store.skipReceivedActions()
    XCTAssertEqual(store.state.screen, .shift)
    XCTAssertEqual(store.state.driver, driver)
  }

  func test_driverLoadRetryTapped_whenNotLoading_isNoOp() async {
    let store = TestStore(initialState: DriverRootFeature.State(screen: .shift)) {
      DriverRootFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.driverLoadRetryTapped)
  }

  // MARK: - Onboarding complete

  func test_onboardingComplete_routesToShift() async {
    let driver = Self.passedDriver()
    let store = TestStore(
      initialState: DriverRootFeature.State(
        screen: .onboarding,
        onboarding: DriverOnboardingFeature.State(step: .pending)
      )
    ) {
      DriverRootFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.onboarding(.delegate(.onboardingComplete(driver)))) {
      $0.driver = driver
      $0.shift = DriverShiftFeature.State(driver: driver)
      $0.screen = .shift
    }
  }

  // MARK: - Earnings push/pop

  func test_openEarningsDetail_pushesEarningsScreen() async {
    let driver = Self.passedDriver()
    let store = TestStore(
      initialState: DriverRootFeature.State(
        screen: .shift,
        driver: driver,
        shift: DriverShiftFeature.State(driver: driver)
      )
    ) {
      DriverRootFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.shift(.delegate(.openEarningsDetail))) {
      $0.earnings = DriverEarningsFeature.State()
      $0.screen = .earnings
    }
  }

  func test_earningsDismissed_popsBackToShift() async {
    let store = TestStore(
      initialState: DriverRootFeature.State(
        screen: .earnings,
        earnings: DriverEarningsFeature.State()
      )
    ) {
      DriverRootFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.earningsDismissed) {
      $0.earnings = nil
      $0.screen = .shift
    }
  }

  // MARK: - Sign out

  func test_signOutTapped_clearsStateAndTokens() async {
    let driver = Self.passedDriver()
    let storage = TokenStorage()
    let store = TestStore(
      initialState: DriverRootFeature.State(
        screen: .shift,
        login: LoginFeature.State(email: "driver@dankdash.com"),
        signedInUser: Self.user(),
        driver: driver,
        onboarding: DriverOnboardingFeature.State(driver: driver),
        shift: DriverShiftFeature.State(driver: driver),
        earnings: DriverEarningsFeature.State(),
        driverLoadError: "stale error"
      )
    ) {
      DriverRootFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.tokenStore = TokenStore(
        loadAccess: { await storage.access },
        loadRefresh: { await storage.refresh },
        persist: { _ in },
        clear: { await storage.clear() }
      )
    }
    store.exhaustivity = .off

    await store.send(.signOutTapped)
    await store.finish()
    XCTAssertNil(store.state.signedInUser)
    XCTAssertNil(store.state.driver)
    XCTAssertNil(store.state.driverLoadError)
    XCTAssertNil(store.state.earnings)
    XCTAssertEqual(store.state.screen, DriverRootFeature.State.Screen.auth)
    XCTAssertEqual(store.state.authScreen, DriverRootFeature.State.AuthScreen.login)
    XCTAssertEqual(store.state.login, LoginFeature.State())
    XCTAssertNil(store.state.shift.driver, "shift state is reset — no driver carried across")
    XCTAssertNil(store.state.shift.activeShift)
    XCTAssertEqual(store.state.onboarding.step, .welcome, "onboarding rewinds to first step on sign-out")
    XCTAssertNil(store.state.onboarding.driver)
    let cleared = await storage.clearedCount
    XCTAssertEqual(cleared, 1)
  }

  // MARK: - Deep link

  func test_deepLinkReceived_stashesURL() async {
    let url = URL(string: "dankdasher://offer/abc")!
    let store = TestStore(initialState: DriverRootFeature.State(screen: .shift)) {
      DriverRootFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.deepLinkReceived(url)) {
      $0.pendingDeepLinkURL = url
    }
    await store.send(.deepLinkConsumed) {
      $0.pendingDeepLinkURL = nil
    }
  }

  // MARK: - Error box

  func test_errorBox_unwrapsEachUnderlyingErrorKind() {
    XCTAssertTrue(DriverBootstrapErrorBox(DriverAppAPIError.endpointNotYetAvailable).isEndpointNotYetAvailable)
    XCTAssertEqual(
      DriverBootstrapErrorBox(DriverAPIError.malformedPayload("Driver")).userFacingMessage(),
      "Couldn't read the response. We'll try again."
    )
    XCTAssertEqual(
      DriverBootstrapErrorBox(APIError.transport(URLError(.notConnectedToInternet))).userFacingMessage(),
      "Couldn't reach DankDash. Check your connection."
    )
    XCTAssertEqual(
      DriverBootstrapErrorBox(APIError.unauthorized).userFacingMessage(),
      "Sign in again to continue."
    )
    let envelope = ErrorEnvelope(error: .init(code: "INTERNAL", message: "boom"))
    XCTAssertEqual(
      DriverBootstrapErrorBox(APIError.server(status: 500, envelope: envelope)).userFacingMessage(),
      "boom"
    )
  }

  // MARK: - Fixtures

  static func disableDependencies(_ values: inout DependencyValues) {
    values.tokenStore = TokenStore(
      loadAccess: { nil },
      loadRefresh: { nil },
      persist: { _ in },
      clear: {}
    )
    values.driverAppAPIClient = .unimplemented
    values.backgroundLocationClient = .unimplemented
    values.batteryMonitorClient = .unimplemented
    values.driverShiftAPIClient = .unimplemented
    values.driverHeatmapAPIClient = .unimplemented
    values.driverSessionStoreClient = .unimplemented
    values.continuousClock = ImmediateClock()
    values.date = .constant(Date(timeIntervalSince1970: 1_700_000_000))
  }

  nonisolated private static func passedDriver(
    backgroundCheckPassedAt: String? = "2024-01-15T12:00:00Z",
    currentStatus: DriverStatus = .offline
  ) -> Driver {
    Driver(
      id: UUID(uuidString: "00000000-0000-0000-0000-0000000000d1")!,
      userId: UUID(uuidString: "00000000-0000-0000-0000-0000000000a1")!,
      vehicle: Vehicle(make: "Honda", model: "Civic", year: 2021, plate: "ABC123", color: "Blue"),
      insuranceDocKey: nil,
      insuranceExpiresAt: "2026-01-01",
      backgroundCheckPassedAt: backgroundCheckPassedAt,
      backgroundCheckProviderRef: backgroundCheckPassedAt == nil ? nil : "veriff-session-abc",
      currentStatus: currentStatus,
      lastStatusChangeAt: Date(timeIntervalSince1970: 1_700_000_000),
      currentLocation: nil,
      currentLocationUpdatedAt: nil,
      currentOrderId: nil,
      ratingAvg: Decimal(string: "4.9"),
      ratingCount: 32,
      totalDeliveries: 64,
      createdAt: Date(timeIntervalSince1970: 1_700_000_000),
      updatedAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
  }

  nonisolated private static func user() -> UserSummaryDTO {
    UserSummaryDTO(
      id: "00000000-0000-0000-0000-0000000000a1",
      email: "driver@dankdash.com",
      phone: nil,
      firstName: "Test",
      lastName: "Driver",
      role: "driver",
      status: "active",
      kycVerified: true,
      mfaEnabled: false,
      createdAt: "2024-01-15T12:00:00Z"
    )
  }

  nonisolated private static func tokens() -> TokenPairDTO {
    TokenPairDTO(
      accessToken: "access",
      refreshToken: "refresh",
      accessTokenExpiresAt: "2026-01-15T12:00:00Z",
      refreshTokenExpiresAt: "2026-04-15T12:00:00Z"
    )
  }
}

/// Test-only token storage so sign-out can both flush and assert that
/// the clear closure was called. Mirrors the in-memory pattern from
/// ``TokenStore.inMemory`` but exposes the clear count for tests.
private actor TokenStorage {
  var access: String? = "access"
  var refresh: String? = "refresh"
  var clearedCount: Int = 0

  func clear() {
    access = nil
    refresh = nil
    clearedCount += 1
  }
}
