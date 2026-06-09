import XCTest
import ComposableArchitecture
import DankDashNetwork
@testable import DankDashFeatures

@MainActor
final class AccountFeatureTests: XCTestCase {
  private func makeUser(firstName: String?, lastName: String?) -> UserSummaryDTO {
    UserSummaryDTO(
      id: "0190b7a4-9c00-72f5-a6b0-1c6f77ce9001",
      email: "alice.kim@example.com",
      phone: nil,
      firstName: firstName,
      lastName: lastName,
      role: "customer",
      status: "active",
      kycVerified: true,
      mfaEnabled: false,
      createdAt: "2026-01-01T00:00:00.000Z"
    )
  }

  // MARK: - onAppear / profile load

  func test_onAppear_firstLoad_showsLoaderThenPopulates() async {
    let user = makeUser(firstName: "Alice", lastName: "Kim")
    let store = TestStore(initialState: AccountFeature.State()) {
      AccountFeature()
    } withDependencies: {
      $0.meAPIClient.getProfile = { user }
    }

    await store.send(.onAppear) { $0.isLoadingProfile = true }
    await store.receive(\.profileLoaded.success) {
      $0.isLoadingProfile = false
      $0.user = user
    }
  }

  func test_onAppear_withCachedUser_refreshesWithoutLoaderFlip() async {
    let cached = makeUser(firstName: "Alice", lastName: "Kim")
    let refreshed = makeUser(firstName: "Alicia", lastName: "Kim")
    let store = TestStore(initialState: AccountFeature.State(user: cached)) {
      AccountFeature()
    } withDependencies: {
      $0.meAPIClient.getProfile = { refreshed }
    }

    await store.send(.onAppear)  // user already present → no loader flicker
    await store.receive(\.profileLoaded.success) { $0.user = refreshed }
  }

  func test_onAppear_firstLoadFailure_clearsLoader_leavesUserNil() async {
    let store = TestStore(initialState: AccountFeature.State()) {
      AccountFeature()
    } withDependencies: {
      $0.meAPIClient.getProfile = { throw APIError.transport(URLError(.timedOut)) }
    }

    await store.send(.onAppear) { $0.isLoadingProfile = true }
    await store.receive(\.profileLoaded.failure) { $0.isLoadingProfile = false }
    XCTAssertNil(store.state.user)
  }

  func test_onAppear_refreshFailure_keepsCachedUser() async {
    let cached = makeUser(firstName: "Alice", lastName: "Kim")
    let store = TestStore(initialState: AccountFeature.State(user: cached)) {
      AccountFeature()
    } withDependencies: {
      $0.meAPIClient.getProfile = { throw APIError.transport(URLError(.notConnectedToInternet)) }
    }

    await store.send(.onAppear)
    await store.receive(\.profileLoaded.failure)
    XCTAssertEqual(store.state.user, cached, "A failed refresh must not wipe the identity already on screen.")
  }

  // MARK: - edit profile

  func test_editProfileTapped_withUser_opensFormSeededFromUser() async {
    let user = makeUser(firstName: "Alice", lastName: "Kim")
    let store = TestStore(initialState: AccountFeature.State(user: user)) {
      AccountFeature()
    }

    await store.send(.editProfileTapped) {
      $0.profileEdit = ProfileEditFeature.State(
        firstName: "Alice",
        lastName: "Kim",
        email: "alice.kim@example.com"
      )
    }
  }

  func test_editProfileTapped_withoutUser_isNoop() async {
    let store = TestStore(initialState: AccountFeature.State()) {
      AccountFeature()
    }

    await store.send(.editProfileTapped)
  }

  func test_profileEditDismissed_clearsForm() async {
    let store = TestStore(
      initialState: AccountFeature.State(profileEdit: ProfileEditFeature.State())
    ) {
      AccountFeature()
    }

    await store.send(.profileEditDismissed) { $0.profileEdit = nil }
  }

  func test_profileEditSavedDelegate_updatesUserAndDismisses() async {
    let original = makeUser(firstName: "Alice", lastName: "Kim")
    let updated = makeUser(firstName: "Alicia", lastName: "Kim")
    let store = TestStore(
      initialState: AccountFeature.State(
        user: original,
        profileEdit: ProfileEditFeature.State(
          firstName: "Alicia",
          lastName: "Kim",
          email: "alice.kim@example.com"
        )
      )
    ) {
      AccountFeature()
    }
    store.exhaustivity = .off

    await store.send(.profileEdit(.delegate(.saved(updated))))
    XCTAssertEqual(store.state.user, updated)
    XCTAssertNil(store.state.profileEdit, "Saving pops the edit form.")
  }

  func test_profileEditCancelledDelegate_dismisses() async {
    let store = TestStore(
      initialState: AccountFeature.State(profileEdit: ProfileEditFeature.State())
    ) {
      AccountFeature()
    }
    store.exhaustivity = .off

    await store.send(.profileEdit(.delegate(.cancelled)))
    XCTAssertNil(store.state.profileEdit)
  }

  // MARK: - saved addresses

  func test_manageAddressesTapped_opensAddresses() async {
    let store = TestStore(initialState: AccountFeature.State()) {
      AccountFeature()
    }

    await store.send(.manageAddressesTapped) {
      $0.addresses = AddressesFeature.State()
    }
  }

  func test_addressesDismissed_clearsAddresses() async {
    let store = TestStore(
      initialState: AccountFeature.State(addresses: AddressesFeature.State())
    ) {
      AccountFeature()
    }

    await store.send(.addressesDismissed) { $0.addresses = nil }
  }

  // MARK: - payment methods

  func test_managePaymentMethodsTapped_opensPaymentMethods() async {
    let store = TestStore(initialState: AccountFeature.State()) {
      AccountFeature()
    }

    await store.send(.managePaymentMethodsTapped) {
      $0.paymentMethods = PaymentMethodsFeature.State()
    }
  }

  func test_paymentMethodsDismissed_clearsPaymentMethods() async {
    let store = TestStore(
      initialState: AccountFeature.State(paymentMethods: PaymentMethodsFeature.State())
    ) {
      AccountFeature()
    }

    await store.send(.paymentMethodsDismissed) { $0.paymentMethods = nil }
  }

  // MARK: - notifications

  func test_manageNotificationsTapped_opensNotifications() async {
    let store = TestStore(initialState: AccountFeature.State()) {
      AccountFeature()
    }

    await store.send(.manageNotificationsTapped) {
      $0.notifications = NotificationPreferencesFeature.State()
    }
  }

  func test_notificationsDismissed_clearsNotifications() async {
    let store = TestStore(
      initialState: AccountFeature.State(notifications: NotificationPreferencesFeature.State())
    ) {
      AccountFeature()
    }

    await store.send(.notificationsDismissed) { $0.notifications = nil }
  }

  // MARK: - delegated concerns

  func test_orderHistoryTapped_emitsShowOrdersDelegate() async {
    let store = TestStore(initialState: AccountFeature.State()) {
      AccountFeature()
    }

    await store.send(.orderHistoryTapped)
    await store.receive(\.delegate.showOrders)
  }

  func test_signOutTapped_emitsSignOutDelegate() async {
    let store = TestStore(initialState: AccountFeature.State()) {
      AccountFeature()
    }

    await store.send(.signOutTapped)
    await store.receive(\.delegate.signOutRequested)
  }
}
