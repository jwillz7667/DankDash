import XCTest
import ComposableArchitecture
import DankDashDomain
@testable import DankDashFeatures

@MainActor
final class CheckoutHandoffFeatureTests: XCTestCase {
  func test_onAppear_kicksOffHandoffRequest_andTransitionsToReadyOnSuccess() async {
    let cartId = UUID()
    let addrId = UUID()
    let argsRecorder = ArgsRecorder()
    let token = makeHandoffToken(expiresAt: Date(timeIntervalSinceReferenceDate: 1_000))

    let store = TestStore(
      initialState: CheckoutHandoffFeature.State(cartId: cartId, deliveryAddressId: addrId)
    ) {
      CheckoutHandoffFeature()
    } withDependencies: {
      $0.handoffAPIClient.createCheckoutHandoff = { cId, aId in
        await argsRecorder.record(cartId: cId, addrId: aId)
        return token
      }
      $0.date.now = Date(timeIntervalSinceReferenceDate: 100)
    }

    await store.send(.onAppear) {
      $0.status = .requesting
    }

    let recorded = await argsRecorder.snapshot()
    XCTAssertEqual(recorded.count, 1)
    XCTAssertEqual(recorded.first?.cartId, cartId)
    XCTAssertEqual(recorded.first?.addrId, addrId)

    await store.receive(\.handoffReceived) {
      $0.status = .readyToOpen(token)
    }
  }

  func test_onAppear_isIdempotent_whenAlreadyRequesting() async {
    let store = TestStore(
      initialState: CheckoutHandoffFeature.State(
        cartId: UUID(),
        deliveryAddressId: UUID(),
        status: .requesting
      )
    ) {
      CheckoutHandoffFeature()
    } withDependencies: {
      $0.handoffAPIClient.createCheckoutHandoff = { _, _ in
        XCTFail("should not fire while requesting")
        return makeHandoffToken()
      }
    }

    await store.send(.onAppear)
  }

  func test_handoffReceived_withExpiredToken_marksFailedExpired() async {
    let expiredToken = makeHandoffToken(expiresAt: Date(timeIntervalSinceReferenceDate: 50))

    let store = TestStore(
      initialState: CheckoutHandoffFeature.State(
        cartId: UUID(),
        deliveryAddressId: UUID(),
        status: .requesting
      )
    ) {
      CheckoutHandoffFeature()
    } withDependencies: {
      $0.date.now = Date(timeIntervalSinceReferenceDate: 100)
    }

    await store.send(.handoffReceived(.success(expiredToken))) {
      $0.status = .failed(.tokenExpired)
    }
  }

  func test_handoffReceived_withFailure_marksFailedWithMessage() async {
    let store = TestStore(
      initialState: CheckoutHandoffFeature.State(
        cartId: UUID(),
        deliveryAddressId: UUID(),
        status: .requesting
      )
    ) {
      CheckoutHandoffFeature()
    } withDependencies: {
      $0.date.now = Date(timeIntervalSinceReferenceDate: 100)
    }

    struct StubError: LocalizedError {
      var errorDescription: String? { "Unable to start checkout." }
    }

    await store.send(.handoffReceived(.failure(EquatableError(StubError())))) {
      $0.status = .failed(.requestFailed("Unable to start checkout."))
    }
  }

  func test_safariOpened_transitionsReadyToAwaiting() async {
    let token = makeHandoffToken()

    let store = TestStore(
      initialState: CheckoutHandoffFeature.State(
        cartId: UUID(),
        deliveryAddressId: UUID(),
        status: .readyToOpen(token)
      )
    ) {
      CheckoutHandoffFeature()
    } withDependencies: {
      $0.date.now = Date(timeIntervalSinceReferenceDate: 100)
    }

    await store.send(.safariOpened) {
      $0.status = .awaitingDeepLink(token)
    }
  }

  func test_safariOpened_isIgnored_whenNotReady() async {
    let store = TestStore(
      initialState: CheckoutHandoffFeature.State(
        cartId: UUID(),
        deliveryAddressId: UUID(),
        status: .idle
      )
    ) {
      CheckoutHandoffFeature()
    }

    await store.send(.safariOpened)
  }

  func test_safariDismissed_dropsBackToIdle_fromAwaitingDeepLink() async {
    let token = makeHandoffToken()

    let store = TestStore(
      initialState: CheckoutHandoffFeature.State(
        cartId: UUID(),
        deliveryAddressId: UUID(),
        status: .awaitingDeepLink(token)
      )
    ) {
      CheckoutHandoffFeature()
    }

    await store.send(.safariDismissed) {
      $0.status = .idle
    }
  }

  func test_safariDismissed_doesNotDowngradeCompletedState() async {
    let orderId = UUID()
    let store = TestStore(
      initialState: CheckoutHandoffFeature.State(
        cartId: UUID(),
        deliveryAddressId: UUID(),
        status: .completed(orderId: orderId)
      )
    ) {
      CheckoutHandoffFeature()
    }

    await store.send(.safariDismissed)
  }

  func test_deepLinkReceived_transitionsCompleted_andEmitsDelegate() async {
    let orderId = UUID()
    let token = makeHandoffToken()
    let store = TestStore(
      initialState: CheckoutHandoffFeature.State(
        cartId: UUID(),
        deliveryAddressId: UUID(),
        status: .awaitingDeepLink(token)
      )
    ) {
      CheckoutHandoffFeature()
    }

    await store.send(.deepLinkReceived(orderId: orderId)) {
      $0.status = .completed(orderId: orderId)
    }
    await store.receive(\.delegate.completed)
  }

  func test_retryTapped_fromFailed_restartsRequest() async {
    let argsRecorder = ArgsRecorder()
    let token = makeHandoffToken()
    let cartId = UUID()
    let addrId = UUID()

    let store = TestStore(
      initialState: CheckoutHandoffFeature.State(
        cartId: cartId,
        deliveryAddressId: addrId,
        status: .failed(.requestFailed("offline"))
      )
    ) {
      CheckoutHandoffFeature()
    } withDependencies: {
      $0.handoffAPIClient.createCheckoutHandoff = { cId, aId in
        await argsRecorder.record(cartId: cId, addrId: aId)
        return token
      }
      $0.date.now = Date(timeIntervalSinceReferenceDate: 100)
    }

    await store.send(.retryTapped) {
      $0.status = .requesting
    }

    await store.receive(\.handoffReceived) {
      $0.status = .readyToOpen(token)
    }

    let count = await argsRecorder.snapshot().count
    XCTAssertEqual(count, 1)
  }

  func test_retryTapped_fromCompleted_isNoop() async {
    let orderId = UUID()
    let store = TestStore(
      initialState: CheckoutHandoffFeature.State(
        cartId: UUID(),
        deliveryAddressId: UUID(),
        status: .completed(orderId: orderId)
      )
    ) {
      CheckoutHandoffFeature()
    } withDependencies: {
      $0.handoffAPIClient.createCheckoutHandoff = { _, _ in
        XCTFail("should not retry from completed")
        return makeHandoffToken()
      }
    }

    await store.send(.retryTapped)
  }

  func test_dismissTapped_emitsDismissedDelegate() async {
    let store = TestStore(
      initialState: CheckoutHandoffFeature.State(
        cartId: UUID(),
        deliveryAddressId: UUID()
      )
    ) {
      CheckoutHandoffFeature()
    }

    await store.send(.dismissTapped)
    await store.receive(\.delegate.dismissed)
  }

  func test_fullHappyPath_idleToCompletedThroughSafari() async {
    let cartId = UUID()
    let addrId = UUID()
    let orderId = UUID()
    let token = makeHandoffToken(expiresAt: Date(timeIntervalSinceReferenceDate: 1_000))

    let store = TestStore(
      initialState: CheckoutHandoffFeature.State(cartId: cartId, deliveryAddressId: addrId)
    ) {
      CheckoutHandoffFeature()
    } withDependencies: {
      $0.handoffAPIClient.createCheckoutHandoff = { _, _ in token }
      $0.date.now = Date(timeIntervalSinceReferenceDate: 100)
    }

    await store.send(.onAppear) { $0.status = .requesting }
    await store.receive(\.handoffReceived) { $0.status = .readyToOpen(token) }
    await store.send(.safariOpened) { $0.status = .awaitingDeepLink(token) }
    await store.send(.deepLinkReceived(orderId: orderId)) {
      $0.status = .completed(orderId: orderId)
    }
    await store.receive(\.delegate.completed)
  }

  func test_presentableToken_isOnlyExposedAfterRequestCompletes() {
    let token = makeHandoffToken()
    let state = CheckoutHandoffFeature.State(
      cartId: UUID(),
      deliveryAddressId: UUID(),
      status: .idle
    )
    XCTAssertNil(state.presentableToken)

    var ready = state
    ready.status = .readyToOpen(token)
    XCTAssertEqual(ready.presentableToken, token)

    var awaiting = state
    awaiting.status = .awaitingDeepLink(token)
    XCTAssertEqual(awaiting.presentableToken, token)

    var completed = state
    completed.status = .completed(orderId: UUID())
    XCTAssertNil(completed.presentableToken)

    var failed = state
    failed.status = .failed(.tokenExpired)
    XCTAssertNil(failed.presentableToken)
  }

  func test_failureMessage_reflectsFailureReason() {
    var state = CheckoutHandoffFeature.State(
      cartId: UUID(),
      deliveryAddressId: UUID()
    )
    state.status = .failed(.requestFailed("Could not reach handoff service."))
    XCTAssertEqual(state.failureMessage, "Could not reach handoff service.")

    state.status = .failed(.tokenExpired)
    XCTAssertEqual(
      state.failureMessage,
      "Your checkout session expired. Tap retry to start over."
    )

    state.status = .idle
    XCTAssertNil(state.failureMessage)
  }

}

// MARK: - Helpers

private func makeHandoffToken(
  expiresAt: Date = Date(timeIntervalSinceReferenceDate: 1_000)
) -> HandoffToken {
  HandoffToken(
    token: "stub.jwt.payload",
    exchangeUrl: URL(string: "https://app.dankdash.com/checkout?handoff=stub")!,
    expiresAt: expiresAt
  )
}

// MARK: - Recorders

private actor ArgsRecorder {
  struct Call: Equatable {
    let cartId: UUID
    let addrId: UUID
  }

  private(set) var calls: [Call] = []

  func record(cartId: UUID, addrId: UUID) {
    calls.append(Call(cartId: cartId, addrId: addrId))
  }

  func snapshot() -> [Call] { calls }
}
