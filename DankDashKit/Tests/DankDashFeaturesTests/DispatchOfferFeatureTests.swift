import XCTest
import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

/// Reducer coverage for the driver-side dispatch-offer card.
///
/// The reducer fans out three concurrent effects on `.onAppear` (haptic
/// + once-per-second tick) plus per-tap async POSTs. We use `TestClock`
/// for deterministic countdown drift and `Locker`/`Recorder` actors to
/// capture side effects the TestStore can't observe directly (haptic
/// pings, API method calls). The non-exhaustive parts assert final
/// state because the three-way `.merge` doesn't guarantee deterministic
/// ordering — only outcomes.
@MainActor
final class DispatchOfferFeatureTests: XCTestCase {

  // MARK: - onAppear

  func test_onAppear_reseedsCountdownAndFiresHaptic() async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let offer = Self.offer(expiresAt: now.addingTimeInterval(30))
    let hapticCalls = Locker<[HapticsClient.NotificationType]>(value: [])
    // A continuation that the haptic effect closes — letting the test
    // observe the side-effect deterministically without sleeping. The
    // timer effect runs forever, so we tear it down with
    // skipInFlightEffects after the haptic is confirmed.
    let hapticFired = AsyncStream<Void>.makeStream()

    let store = TestStore(
      initialState: DispatchOfferFeature.State(offer: offer, secondsRemaining: 999)
    ) {
      DispatchOfferFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.hapticsClient = HapticsClient(
        notify: { type in
          await hapticCalls.append(type)
          hapticFired.continuation.finish()
        },
        impact: { _ in }
      )
      $0.continuousClock = TestClock()
      $0.date = .constant(now)
    }
    store.exhaustivity = .off

    await store.send(.onAppear) {
      $0.secondsRemaining = 30
    }

    // Wait for the haptic effect to land before sampling the recorder,
    // then cancel the still-running timer.
    for await _ in hapticFired.stream {}
    let recorded = await hapticCalls.value
    XCTAssertEqual(recorded, [.warning])
    await store.skipInFlightEffects()
  }

  func test_onAppear_alreadyExpired_firesExpiredDelegateImmediately() async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let offer = Self.offer(expiresAt: now.addingTimeInterval(-5))

    let store = TestStore(
      initialState: DispatchOfferFeature.State(offer: offer, secondsRemaining: 30)
    ) {
      DispatchOfferFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.date = .constant(now)
    }

    await store.send(.onAppear) {
      $0.secondsRemaining = 0
    }
    await store.receive(\.delegate.expired)
  }

  // MARK: - tick

  func test_tick_priorToExpiry_updatesCountdown() async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let offer = Self.offer(expiresAt: now.addingTimeInterval(25))

    let store = TestStore(
      initialState: DispatchOfferFeature.State(offer: offer, secondsRemaining: 30)
    ) {
      DispatchOfferFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.date = .constant(now)
    }

    await store.send(.tick) {
      $0.secondsRemaining = 25
    }
  }

  func test_tick_pastExpiry_firesExpiredDelegateAndTearsDown() async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let offer = Self.offer(expiresAt: now.addingTimeInterval(-1))

    let store = TestStore(
      initialState: DispatchOfferFeature.State(offer: offer, secondsRemaining: 5)
    ) {
      DispatchOfferFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.date = .constant(now)
    }

    await store.send(.tick) {
      $0.secondsRemaining = 0
    }
    await store.receive(\.delegate.expired)
  }

  // MARK: - Accept

  func test_acceptTapped_happyPath_emitsAcceptedDelegate() async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let offer = Self.offer(expiresAt: now.addingTimeInterval(20))
    let acceptedOffer = Self.offer(
      id: offer.id,
      expiresAt: offer.expiresAt,
      status: .accepted
    )
    let acceptCalls = Locker<[UUID]>(value: [])

    let store = TestStore(
      initialState: DispatchOfferFeature.State(offer: offer, secondsRemaining: 20)
    ) {
      DispatchOfferFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.dispatchOfferAPIClient = DispatchOfferAPIClient(
        accept: { id in
          await acceptCalls.append(id)
          return acceptedOffer
        },
        decline: { _, _ in throw DriverAPIError.unimplemented("decline") }
      )
      $0.date = .constant(now)
    }

    await store.send(.acceptTapped) {
      $0.isSubmitting = true
    }
    await store.receive(\.acceptResponse.success) {
      $0.isSubmitting = false
      $0.offer = acceptedOffer
    }
    await store.receive(\.delegate.accepted)

    let recordedIds = await acceptCalls.value
    XCTAssertEqual(recordedIds, [offer.id])
  }

  func test_acceptTapped_409OfferTaken_emitsUnavailableDelegate() async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let offer = Self.offer(expiresAt: now.addingTimeInterval(20))

    let store = TestStore(
      initialState: DispatchOfferFeature.State(offer: offer, secondsRemaining: 20)
    ) {
      DispatchOfferFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.dispatchOfferAPIClient = DispatchOfferAPIClient(
        accept: { _ in
          throw APIError.server(
            status: 409,
            envelope: Self.envelope(code: "OFFER_NO_LONGER_AVAILABLE")
          )
        },
        decline: { _, _ in throw DriverAPIError.unimplemented("decline") }
      )
      $0.date = .constant(now)
    }

    await store.send(.acceptTapped) {
      $0.isSubmitting = true
    }
    await store.receive(\.acceptResponse.failure) {
      $0.isSubmitting = false
    }
    await store.receive(\.delegate.unavailable)
  }

  func test_acceptTapped_500WithGenericCode_setsErrorBannerAndStays() async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let offer = Self.offer(expiresAt: now.addingTimeInterval(20))

    let store = TestStore(
      initialState: DispatchOfferFeature.State(offer: offer, secondsRemaining: 20)
    ) {
      DispatchOfferFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.dispatchOfferAPIClient = DispatchOfferAPIClient(
        accept: { _ in
          throw APIError.server(
            status: 500,
            envelope: Self.envelope(code: "INTERNAL_ERROR", message: "Server hiccuped")
          )
        },
        decline: { _, _ in throw DriverAPIError.unimplemented("decline") }
      )
      $0.date = .constant(now)
    }

    await store.send(.acceptTapped) {
      $0.isSubmitting = true
    }
    await store.receive(\.acceptResponse.failure) {
      $0.isSubmitting = false
      $0.errorBanner = "Server hiccuped"
    }
    // No delegate received — the sheet stays open so the driver can retry.
    await store.finish()
  }

  // MARK: - Decline

  func test_declineTapped_happyPath_emitsDeclinedDelegate() async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let offer = Self.offer(expiresAt: now.addingTimeInterval(20))
    let declinedOffer = Self.offer(
      id: offer.id,
      expiresAt: offer.expiresAt,
      status: .declined
    )
    let declineCalls = Locker<[DeclineCall]>(value: [])

    let store = TestStore(
      initialState: DispatchOfferFeature.State(offer: offer, secondsRemaining: 20)
    ) {
      DispatchOfferFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.dispatchOfferAPIClient = DispatchOfferAPIClient(
        accept: { _ in throw DriverAPIError.unimplemented("accept") },
        decline: { id, reason in
          await declineCalls.append(DeclineCall(id: id, reason: reason))
          return declinedOffer
        }
      )
      $0.date = .constant(now)
    }

    await store.send(.declineTapped) {
      $0.isSubmitting = true
    }
    await store.receive(\.declineResponse.success) {
      $0.isSubmitting = false
      $0.offer = declinedOffer
    }
    await store.receive(\.delegate.declined)

    let calls = await declineCalls.value
    XCTAssertEqual(calls, [DeclineCall(id: offer.id, reason: nil)])
  }

  func test_declineTapped_409OfferTaken_stillEmitsDeclinedDelegate() async {
    // Decline-after-already-gone is treated as success: the offer is no
    // longer the driver's to respond to. The sheet should dismiss
    // through the same .declined delegate path the happy path uses, so
    // the parent doesn't need a special "decline-but-also-taken"
    // branch.
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let offer = Self.offer(expiresAt: now.addingTimeInterval(20))

    let store = TestStore(
      initialState: DispatchOfferFeature.State(offer: offer, secondsRemaining: 20)
    ) {
      DispatchOfferFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.dispatchOfferAPIClient = DispatchOfferAPIClient(
        accept: { _ in throw DriverAPIError.unimplemented("accept") },
        decline: { _, _ in
          throw APIError.server(
            status: 409,
            envelope: Self.envelope(code: "OFFER_NOT_OFFERED")
          )
        }
      )
      $0.date = .constant(now)
    }

    await store.send(.declineTapped) {
      $0.isSubmitting = true
    }
    await store.receive(\.declineResponse.failure) {
      $0.isSubmitting = false
    }
    await store.receive(\.delegate.declined)
  }

  func test_declineTapped_5xxRecoverable_setsErrorBannerAndStays() async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let offer = Self.offer(expiresAt: now.addingTimeInterval(20))

    let store = TestStore(
      initialState: DispatchOfferFeature.State(offer: offer, secondsRemaining: 20)
    ) {
      DispatchOfferFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.dispatchOfferAPIClient = DispatchOfferAPIClient(
        accept: { _ in throw DriverAPIError.unimplemented("accept") },
        decline: { _, _ in
          throw APIError.server(
            status: 503,
            envelope: Self.envelope(code: "SERVICE_UNAVAILABLE", message: "Try again shortly")
          )
        }
      )
      $0.date = .constant(now)
    }

    await store.send(.declineTapped) {
      $0.isSubmitting = true
    }
    await store.receive(\.declineResponse.failure) {
      $0.isSubmitting = false
      $0.errorBanner = "Try again shortly"
    }
    await store.finish()
  }

  // MARK: - canRespond guards

  func test_acceptTapped_whileSubmitting_isNoOp() async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let offer = Self.offer(expiresAt: now.addingTimeInterval(20))
    let store = TestStore(
      initialState: DispatchOfferFeature.State(
        offer: offer,
        secondsRemaining: 20,
        isSubmitting: true
      )
    ) {
      DispatchOfferFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.date = .constant(now)
    }

    await store.send(.acceptTapped)
  }

  func test_acceptTapped_pastCountdown_isNoOp() async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let offer = Self.offer(expiresAt: now.addingTimeInterval(20))
    let store = TestStore(
      initialState: DispatchOfferFeature.State(
        offer: offer,
        secondsRemaining: 0
      )
    ) {
      DispatchOfferFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.date = .constant(now)
    }

    await store.send(.acceptTapped)
  }

  func test_declineTapped_whileSubmitting_isNoOp() async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let offer = Self.offer(expiresAt: now.addingTimeInterval(20))
    let store = TestStore(
      initialState: DispatchOfferFeature.State(
        offer: offer,
        secondsRemaining: 20,
        isSubmitting: true
      )
    ) {
      DispatchOfferFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.date = .constant(now)
    }

    await store.send(.declineTapped)
  }

  // MARK: - Banner dismiss

  func test_errorBannerDismissed_clearsBanner() async {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let offer = Self.offer(expiresAt: now.addingTimeInterval(20))
    let store = TestStore(
      initialState: DispatchOfferFeature.State(
        offer: offer,
        secondsRemaining: 20,
        errorBanner: "oops"
      )
    ) {
      DispatchOfferFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.date = .constant(now)
    }

    await store.send(.errorBannerDismissed) {
      $0.errorBanner = nil
    }
  }

  // MARK: - State helpers

  func test_canRespond_falseWhenSubmitting() {
    let offer = Self.offer(expiresAt: Date(timeIntervalSinceReferenceDate: 0))
    var state = DispatchOfferFeature.State(offer: offer, secondsRemaining: 20)
    XCTAssertTrue(state.canRespond)
    state.isSubmitting = true
    XCTAssertFalse(state.canRespond)
  }

  func test_canRespond_falseWhenCountdownDone() {
    let offer = Self.offer(expiresAt: Date(timeIntervalSinceReferenceDate: 0))
    var state = DispatchOfferFeature.State(offer: offer, secondsRemaining: 0)
    XCTAssertFalse(state.canRespond)
    state.secondsRemaining = 0.5
    XCTAssertTrue(state.canRespond)
  }

  // MARK: - OfferErrorBox classification

  func test_offerErrorBox_classifies409Status_asOfferTaken() {
    let error = APIError.server(
      status: 409,
      envelope: Self.envelope(code: "SOME_OTHER_CODE", message: "irrelevant")
    )
    XCTAssertTrue(OfferErrorBox(error).isOfferTaken)
  }

  func test_offerErrorBox_classifiesOfferNoLongerAvailableCode_asOfferTaken() {
    // The server is allowed to send 200 OK + code = "OFFER_NO_LONGER_AVAILABLE"
    // when racing — the code wins, not the status.
    let error = APIError.server(
      status: 200,
      envelope: Self.envelope(code: "OFFER_NO_LONGER_AVAILABLE")
    )
    XCTAssertTrue(OfferErrorBox(error).isOfferTaken)
  }

  func test_offerErrorBox_classifiesOfferNotOfferedCode_asOfferTaken() {
    let error = APIError.server(
      status: 409,
      envelope: Self.envelope(code: "OFFER_NOT_OFFERED")
    )
    XCTAssertTrue(OfferErrorBox(error).isOfferTaken)
  }

  func test_offerErrorBox_classifiesOfferExpiredCode_asOfferTaken() {
    let error = APIError.server(
      status: 410,
      envelope: Self.envelope(code: "OFFER_EXPIRED")
    )
    XCTAssertTrue(OfferErrorBox(error).isOfferTaken)
  }

  func test_offerErrorBox_classifies500_asRecoverableServerError() {
    let error = APIError.server(
      status: 500,
      envelope: Self.envelope(code: "INTERNAL_ERROR", message: "kaboom")
    )
    let box = OfferErrorBox(error)
    XCTAssertFalse(box.isOfferTaken)
    XCTAssertEqual(box.userFacingMessage(), "kaboom")
  }

  func test_offerErrorBox_classifiesTransport_asConnectionError() {
    let underlying = NSError(domain: "URLSession", code: -1009)
    let error = APIError.transport(underlying)
    let box = OfferErrorBox(error)
    XCTAssertFalse(box.isOfferTaken)
    XCTAssertEqual(box.userFacingMessage(), "Couldn't reach DankDash. Check your connection.")
  }

  func test_offerErrorBox_classifiesUnauthorized() {
    let box = OfferErrorBox(APIError.unauthorized)
    XCTAssertEqual(box.userFacingMessage(), "Sign in again to continue.")
  }

  func test_offerErrorBox_classifiesDriverAPIErrorMalformed() {
    let box = OfferErrorBox(DriverAPIError.malformedPayload("DispatchOffer"))
    if case .malformed(let label) = box.kind {
      XCTAssertEqual(label, "DispatchOffer")
    } else {
      XCTFail("expected .malformed kind, got \(box.kind)")
    }
    XCTAssertEqual(box.userFacingMessage(), "Couldn't read the response. We'll try again.")
  }

  // MARK: - Fixtures

  nonisolated private static func offer(
    id: UUID = UUID(uuidString: "00000000-0000-0000-0000-0000000000f1")!,
    expiresAt: Date,
    status: DispatchOffer.Status = .offered
  ) -> DispatchOffer {
    DispatchOffer(
      id: id,
      orderId: UUID(uuidString: "00000000-0000-0000-0000-0000000000e1")!,
      driverId: UUID(uuidString: "00000000-0000-0000-0000-0000000000d1")!,
      offeredAt: expiresAt.addingTimeInterval(-30),
      expiresAt: expiresAt,
      payoutEstimateCents: 1_250,
      distanceMiles: Decimal(string: "2.4") ?? 0,
      status: status,
      respondedAt: nil,
      declineReason: nil
    )
  }

  nonisolated private static func envelope(
    code: String,
    message: String = "msg"
  ) -> ErrorEnvelope {
    ErrorEnvelope(error: ErrorEnvelope.ErrorBody(code: code, message: message))
  }

  /// Wires safe stubs across every dependency so a forgotten override
  /// surfaces as a TestStore "unexpected effect" rather than the live
  /// binding being touched.
  static func disableDependencies(_ values: inout DependencyValues) {
    values.dispatchOfferAPIClient = .unimplemented
    values.hapticsClient = .noop
    values.continuousClock = ImmediateClock()
    values.date = .constant(Date(timeIntervalSince1970: 1_700_000_000))
  }
}

// MARK: - Helpers

private struct DeclineCall: Sendable, Equatable {
  let id: UUID
  let reason: String?
}

private actor Locker<T: Sendable> {
  private(set) var value: T
  init(value: T) { self.value = value }
}

private extension Locker where T == [HapticsClient.NotificationType] {
  func append(_ type: HapticsClient.NotificationType) { value.append(type) }
}

private extension Locker where T == [UUID] {
  func append(_ id: UUID) { value.append(id) }
}

private extension Locker where T == [DeclineCall] {
  func append(_ call: DeclineCall) { value.append(call) }
}
