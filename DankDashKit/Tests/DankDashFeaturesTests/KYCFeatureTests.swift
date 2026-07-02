import XCTest
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

@MainActor
final class KYCFeatureTests: XCTestCase {
  // MARK: - Fixtures

  private let inquiry = KYCInquiry(
    inquiryId: "inq_123",
    inquiryURL: URL(string: "https://withpersona.com/verify?inquiry-id=inq_123")!
  )

  private struct StartError: LocalizedError {
    var errorDescription: String? { "Verification is temporarily unavailable." }
  }

  // MARK: - Inquiry creation

  func test_beginTapped_startsInquiry_andTransitionsToReadyToOpen() async {
    let recorder = CallCounter()
    let store = TestStore(initialState: KYCFeature.State()) {
      KYCFeature()
    } withDependencies: {
      $0.kycAPIClient.startInquiry = {
        await recorder.increment()
        return self.inquiry
      }
    }

    await store.send(.beginTapped) { $0.phase = .starting }
    await store.receive(\.startResponse) { $0.phase = .readyToOpen(self.inquiry) }

    let count = await recorder.value
    XCTAssertEqual(count, 1)
  }

  func test_beginTapped_isIdempotent_whileStarting() async {
    let store = TestStore(initialState: KYCFeature.State(phase: .starting)) {
      KYCFeature()
    } withDependencies: {
      $0.kycAPIClient.startInquiry = {
        XCTFail("should not mint a second inquiry while starting")
        return self.inquiry
      }
    }

    await store.send(.beginTapped)
  }

  func test_startResponse_failure_marksFailedWithMessage() async {
    let store = TestStore(initialState: KYCFeature.State(phase: .intro)) {
      KYCFeature()
    } withDependencies: {
      $0.kycAPIClient.startInquiry = { throw StartError() }
    }

    await store.send(.beginTapped) { $0.phase = .starting }
    await store.receive(\.startResponse) {
      $0.phase = .failed(.startFailed("Verification is temporarily unavailable."))
    }
  }

  func test_retryTapped_fromFailed_restartsInquiry() async {
    let store = TestStore(
      initialState: KYCFeature.State(phase: .failed(.startFailed("offline")))
    ) {
      KYCFeature()
    } withDependencies: {
      $0.kycAPIClient.startInquiry = { self.inquiry }
    }

    await store.send(.retryTapped) { $0.phase = .starting }
    await store.receive(\.startResponse) { $0.phase = .readyToOpen(self.inquiry) }
  }

  func test_restartTapped_fromPendingReview_mintsFreshInquiry() async {
    let store = TestStore(initialState: KYCFeature.State(phase: .pendingReview)) {
      KYCFeature()
    } withDependencies: {
      $0.kycAPIClient.startInquiry = { self.inquiry }
    }

    await store.send(.restartTapped) { $0.phase = .starting }
    await store.receive(\.startResponse) { $0.phase = .readyToOpen(self.inquiry) }
  }

  // MARK: - Safari lifecycle

  func test_safariOpened_transitionsReadyToAwaiting() async {
    let store = TestStore(initialState: KYCFeature.State(phase: .readyToOpen(inquiry))) {
      KYCFeature()
    }

    await store.send(.safariOpened) { $0.phase = .awaitingReturn(self.inquiry) }
  }

  func test_safariOpened_isIgnored_whenNotReady() async {
    let store = TestStore(initialState: KYCFeature.State(phase: .intro)) {
      KYCFeature()
    }

    await store.send(.safariOpened)
  }

  func test_safariDismissed_isIgnored_whenNotAwaiting() async {
    let store = TestStore(initialState: KYCFeature.State(phase: .intro)) {
      KYCFeature()
    }

    await store.send(.safariDismissed)
  }

  // MARK: - Polling /me after return

  func test_safariDismissed_polls_andApprovesWhenVerified() async {
    let store = TestStore(initialState: KYCFeature.State(phase: .awaitingReturn(inquiry))) {
      KYCFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
      $0.meAPIClient.getProfile = { makeUser(kycVerified: true) }
    }

    await store.send(.safariDismissed) { $0.phase = .verifying }
    await store.receive(\.pollTick)
    await store.receive(\.pollResponse) { $0.phase = .approved }
    await store.receive(\.delegate.verified)
  }

  func test_pollResponse_notVerified_beforeBudget_reschedulesAndStaysVerifying() async {
    let clock = TestClock()
    let store = TestStore(initialState: KYCFeature.State(phase: .verifying)) {
      KYCFeature()
    } withDependencies: {
      $0.continuousClock = clock
    }

    // A non-verified poll below the budget must not settle into
    // pendingReview — it schedules another attempt.
    await store.send(.pollResponse(.success(false), attempt: 1))

    // Drain the pending reschedule cleanly.
    await store.send(.dismissTapped)
    await store.receive(\.delegate.dismissed)
  }

  func test_pollResponse_notVerified_atBudget_settlesToPendingReview() async {
    let store = TestStore(initialState: KYCFeature.State(phase: .verifying)) {
      KYCFeature()
    }

    await store.send(.pollResponse(.success(false), attempt: KYCFeature.maxPollAttempts)) {
      $0.phase = .pendingReview
    }
  }

  func test_pollResponse_failure_atBudget_settlesToPendingReview() async {
    let store = TestStore(initialState: KYCFeature.State(phase: .verifying)) {
      KYCFeature()
    }

    await store.send(
      .pollResponse(.failure(EquatableError(message: "offline")), attempt: KYCFeature.maxPollAttempts)
    ) {
      $0.phase = .pendingReview
    }
  }

  func test_checkAgainTapped_reChecksOnce_andApprovesWhenVerified() async {
    let store = TestStore(initialState: KYCFeature.State(phase: .pendingReview)) {
      KYCFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
      $0.meAPIClient.getProfile = { makeUser(kycVerified: true) }
    }

    await store.send(.checkAgainTapped) { $0.phase = .verifying }
    await store.receive(\.pollTick)
    await store.receive(\.pollResponse) { $0.phase = .approved }
    await store.receive(\.delegate.verified)
  }

  func test_checkAgainTapped_reChecksOnce_fallsBackToPendingReviewWhenStillUnverified() async {
    let store = TestStore(initialState: KYCFeature.State(phase: .pendingReview)) {
      KYCFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
      $0.meAPIClient.getProfile = { makeUser(kycVerified: false) }
    }

    await store.send(.checkAgainTapped) { $0.phase = .verifying }
    await store.receive(\.pollTick)
    // Seeded at the budget, so a single non-verified response settles
    // straight back to pendingReview without re-spinning the budget.
    await store.receive(\.pollResponse) { $0.phase = .pendingReview }
  }

  // MARK: - Dismissal

  func test_dismissTapped_emitsDismissedDelegate() async {
    let store = TestStore(initialState: KYCFeature.State(phase: .intro)) {
      KYCFeature()
    }

    await store.send(.dismissTapped)
    await store.receive(\.delegate.dismissed)
  }

  // MARK: - Full happy path

  func test_fullHappyPath_introToVerifiedThroughSafari() async {
    let store = TestStore(initialState: KYCFeature.State()) {
      KYCFeature()
    } withDependencies: {
      $0.continuousClock = ImmediateClock()
      $0.kycAPIClient.startInquiry = { self.inquiry }
      $0.meAPIClient.getProfile = { makeUser(kycVerified: true) }
    }

    await store.send(.beginTapped) { $0.phase = .starting }
    await store.receive(\.startResponse) { $0.phase = .readyToOpen(self.inquiry) }
    await store.send(.safariOpened) { $0.phase = .awaitingReturn(self.inquiry) }
    await store.send(.safariDismissed) { $0.phase = .verifying }
    await store.receive(\.pollTick)
    await store.receive(\.pollResponse) { $0.phase = .approved }
    await store.receive(\.delegate.verified)
  }

  // MARK: - State projections

  func test_presentableInquiry_onlyExposedWithLiveInquiry() {
    var state = KYCFeature.State(phase: .intro)
    XCTAssertNil(state.presentableInquiry)

    state.phase = .readyToOpen(inquiry)
    XCTAssertEqual(state.presentableInquiry, inquiry)

    state.phase = .awaitingReturn(inquiry)
    XCTAssertEqual(state.presentableInquiry, inquiry)

    state.phase = .verifying
    XCTAssertNil(state.presentableInquiry)

    state.phase = .approved
    XCTAssertNil(state.presentableInquiry)
  }

  func test_isBusy_reflectsStartingAndVerifying() {
    var state = KYCFeature.State(phase: .intro)
    XCTAssertFalse(state.isBusy)

    state.phase = .starting
    XCTAssertTrue(state.isBusy)

    state.phase = .verifying
    XCTAssertTrue(state.isBusy)

    state.phase = .readyToOpen(inquiry)
    XCTAssertFalse(state.isBusy)
  }

  func test_failureMessage_reflectsFailedPhase() {
    var state = KYCFeature.State(phase: .failed(.startFailed("Could not start.")))
    XCTAssertEqual(state.failureMessage, "Could not start.")

    state.phase = .pendingReview
    XCTAssertNil(state.failureMessage)
  }
}

// MARK: - Fixtures

private func makeUser(kycVerified: Bool) -> UserSummaryDTO {
  UserSummaryDTO(
    id: "0190b7a4-9c00-72f5-a6b0-1c6f77ce9001",
    email: "alice.kim@example.com",
    phone: nil,
    firstName: "Alice",
    lastName: "Kim",
    role: "customer",
    status: kycVerified ? "active" : "pending_kyc",
    kycVerified: kycVerified,
    mfaEnabled: false,
    createdAt: "2026-01-01T00:00:00.000Z"
  )
}

// MARK: - Recorders

private actor CallCounter {
  private(set) var value = 0
  func increment() { value += 1 }
}
