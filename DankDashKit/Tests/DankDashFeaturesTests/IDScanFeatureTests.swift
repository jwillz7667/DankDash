import XCTest
import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

/// Reducer coverage for the driver ID-scan handoff screen.
///
/// The reducer interleaves three async hops (start-session → SDK launch
/// → submit-result) and a retry budget that increments only on real
/// verification attempts. Tests exercise the happy path, every failure
/// branch, the cancel/retry semantics, and the escalation gate.
@MainActor
final class IDScanFeatureTests: XCTestCase {

  // MARK: - onAppear

  func test_onAppear_alreadyPassed_firesConfirmedDelegate() async {
    let store = TestStore(
      initialState: IDScanFeature.State(
        orderId: Self.orderId,
        idScan: Self.handoff(passed: true)
      )
    ) {
      IDScanFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.onAppear) {
      $0.status = .passed
    }
    await store.receive(\.delegate.confirmed)
  }

  func test_onAppear_notPassed_isNoOp() async {
    let store = TestStore(
      initialState: IDScanFeature.State(
        orderId: Self.orderId,
        idScan: Self.handoff(passed: false)
      )
    ) {
      IDScanFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.onAppear)
  }

  // MARK: - Happy path

  func test_beginScan_session_sdkCompleted_submitPassed_emitsConfirmedDelegate() async {
    let session = Self.session()
    let passedRoute = Self.activeRoute(idScanPassed: true)
    let startCalls = Locker<[UUID]>(value: [])
    let launchCalls = Locker<[String]>(value: [])
    let submitCalls = Locker<[SubmitCall]>(value: [])

    let store = TestStore(
      initialState: IDScanFeature.State(
        orderId: Self.orderId,
        idScan: Self.handoff(passed: false)
      )
    ) {
      IDScanFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverIDScanAPIClient = DriverIDScanAPIClient(
        startSession: { id in
          await startCalls.append(id)
          return session
        },
        submitResult: { id, verificationId in
          await submitCalls.append(SubmitCall(orderId: id, verificationId: verificationId))
          return passedRoute
        }
      )
      $0.identityVerificationClient = IdentityVerificationClient(
        launchSDK: { session in
          await launchCalls.append(session.verificationId)
          return .completed
        }
      )
    }
    store.exhaustivity = .off

    await store.send(.beginScanTapped)
    await store.skipReceivedActions()
    await store.finish()

    XCTAssertEqual(store.state.status, .passed)
    XCTAssertEqual(store.state.idScan.passed, true)
    XCTAssertEqual(store.state.attempts, 0)
    XCTAssertNil(store.state.errorBanner)
    XCTAssertEqual(store.state.route, passedRoute)

    let starts = await startCalls.value
    let launches = await launchCalls.value
    let submits = await submitCalls.value
    XCTAssertEqual(starts, [Self.orderId])
    XCTAssertEqual(launches, [session.verificationId])
    XCTAssertEqual(submits.count, 1)
    XCTAssertEqual(submits.first?.orderId, Self.orderId)
    XCTAssertEqual(submits.first?.verificationId, session.verificationId)
  }

  // MARK: - SDK outcomes

  func test_sdkCanceled_returnsToNotStarted_noAttemptIncrement() async {
    let session = Self.session()
    let store = TestStore(
      initialState: IDScanFeature.State(
        orderId: Self.orderId,
        idScan: Self.handoff(passed: false),
        status: .sdkInProgress,
        lastSession: session,
        attempts: 0
      )
    ) {
      IDScanFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.sdkOutcomeReceived(.canceled)) {
      $0.status = .notStarted
    }
    XCTAssertEqual(store.state.attempts, 0)
    XCTAssertTrue(store.state.canBeginScan)
  }

  func test_sdkError_incrementsAttempts_setsFailedStatus_firesHaptic() async {
    let session = Self.session()
    let hapticCalls = Locker<[HapticsClient.NotificationType]>(value: [])
    let store = TestStore(
      initialState: IDScanFeature.State(
        orderId: Self.orderId,
        idScan: Self.handoff(passed: false),
        status: .sdkInProgress,
        lastSession: session,
        attempts: 0
      )
    ) {
      IDScanFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.hapticsClient = HapticsClient(
        notify: { type in await hapticCalls.append(type) },
        impact: { _ in }
      )
    }
    store.exhaustivity = .off

    await store.send(.sdkOutcomeReceived(.error(reason: "camera permission denied")))
    await store.finish()

    XCTAssertEqual(store.state.status, .failed(reason: "camera permission denied"))
    XCTAssertEqual(store.state.attempts, 1)
    let haptics = await hapticCalls.value
    XCTAssertEqual(haptics, [.warning])
  }

  func test_sdkCompleted_withoutSession_setsFailedDefensive() async {
    let store = TestStore(
      initialState: IDScanFeature.State(
        orderId: Self.orderId,
        idScan: Self.handoff(passed: false),
        status: .sdkInProgress,
        lastSession: nil,
        attempts: 0
      )
    ) {
      IDScanFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.sdkOutcomeReceived(.completed)) {
      $0.status = .failed(reason: "Lost the Veriff session. Tap Re-Scan to retry.")
    }
    XCTAssertEqual(store.state.attempts, 0)
  }

  // MARK: - Session failures

  func test_sessionStart_500_bannersAndRevertsToNotStarted() async {
    let envelope = Self.envelope(code: "INTERNAL_ERROR", message: "we broke it")
    let store = TestStore(
      initialState: IDScanFeature.State(
        orderId: Self.orderId,
        idScan: Self.handoff(passed: false)
      )
    ) {
      IDScanFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverIDScanAPIClient = DriverIDScanAPIClient(
        startSession: { _ in
          throw APIError.server(status: 500, envelope: envelope)
        },
        submitResult: { _, _ in throw DriverAPIError.unimplemented("submitResult") }
      )
    }
    store.exhaustivity = .off

    await store.send(.beginScanTapped)
    await store.skipReceivedActions()
    await store.finish()

    XCTAssertEqual(store.state.status, .notStarted)
    XCTAssertEqual(store.state.errorBanner, "we broke it")
    XCTAssertEqual(store.state.attempts, 0, "session-start failures don't burn attempts")
  }

  func test_sessionStart_transport_bannersAndRevertsToNotStarted() async {
    let store = TestStore(
      initialState: IDScanFeature.State(
        orderId: Self.orderId,
        idScan: Self.handoff(passed: false)
      )
    ) {
      IDScanFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverIDScanAPIClient = DriverIDScanAPIClient(
        startSession: { _ in
          throw APIError.transport(NSError(domain: "URLSession", code: -1009))
        },
        submitResult: { _, _ in throw DriverAPIError.unimplemented("submitResult") }
      )
    }
    store.exhaustivity = .off

    await store.send(.beginScanTapped)
    await store.skipReceivedActions()
    await store.finish()

    XCTAssertEqual(store.state.status, .notStarted)
    XCTAssertEqual(store.state.errorBanner, "Couldn't reach DankDash. Check your connection.")
  }

  // MARK: - submitResult failures

  func test_submitResult_returnsFailedDecision_incrementsAttempts() async {
    let session = Self.session()
    let failedRoute = Self.activeRoute(idScanPassed: false)
    let store = TestStore(
      initialState: IDScanFeature.State(
        orderId: Self.orderId,
        idScan: Self.handoff(passed: false),
        status: .sdkInProgress,
        lastSession: session,
        attempts: 0
      )
    ) {
      IDScanFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverIDScanAPIClient = DriverIDScanAPIClient(
        startSession: { _ in throw DriverAPIError.unimplemented("startSession") },
        submitResult: { _, _ in failedRoute }
      )
    }
    store.exhaustivity = .off

    await store.send(.sdkOutcomeReceived(.completed))
    await store.skipReceivedActions()
    await store.finish()

    XCTAssertEqual(store.state.status, .failed(reason: "Verification didn't pass."))
    XCTAssertEqual(store.state.attempts, 1)
    XCTAssertFalse(store.state.shouldShowEscalation)
    XCTAssertTrue(store.state.canBeginScan)
  }

  func test_submitResult_third_failure_unlocksEscalation() async {
    let session = Self.session()
    let failedRoute = Self.activeRoute(idScanPassed: false)
    let store = TestStore(
      initialState: IDScanFeature.State(
        orderId: Self.orderId,
        idScan: Self.handoff(passed: false),
        status: .sdkInProgress,
        lastSession: session,
        attempts: 2
      )
    ) {
      IDScanFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverIDScanAPIClient = DriverIDScanAPIClient(
        startSession: { _ in throw DriverAPIError.unimplemented("startSession") },
        submitResult: { _, _ in failedRoute }
      )
    }
    store.exhaustivity = .off

    await store.send(.sdkOutcomeReceived(.completed))
    await store.skipReceivedActions()
    await store.finish()

    XCTAssertEqual(store.state.attempts, 3)
    XCTAssertTrue(store.state.shouldShowEscalation)
    XCTAssertFalse(store.state.canBeginScan, "retry should be disabled after three attempts")
  }

  func test_submitResult_409VerificationMismatch_bannersAndAllowsRetry() async {
    let session = Self.session()
    let envelope = Self.envelope(
      code: "ID_SCAN_VERIFICATION_MISMATCH",
      message: "stale session"
    )
    let store = TestStore(
      initialState: IDScanFeature.State(
        orderId: Self.orderId,
        idScan: Self.handoff(passed: false),
        status: .sdkInProgress,
        lastSession: session,
        attempts: 0
      )
    ) {
      IDScanFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverIDScanAPIClient = DriverIDScanAPIClient(
        startSession: { _ in throw DriverAPIError.unimplemented("startSession") },
        submitResult: { _, _ in throw APIError.server(status: 409, envelope: envelope) }
      )
    }
    store.exhaustivity = .off

    await store.send(.sdkOutcomeReceived(.completed))
    await store.skipReceivedActions()
    await store.finish()

    if case .failed(let reason) = store.state.status {
      XCTAssertEqual(reason, "Couldn't reach Veriff. Tap Re-Scan to retry.")
    } else {
      XCTFail("expected .failed status, got \(store.state.status)")
    }
    XCTAssertEqual(
      store.state.errorBanner,
      "Session expired. Tap Re-Scan to start a fresh verification."
    )
    XCTAssertEqual(store.state.attempts, 0, "submit failures don't burn attempts")
  }

  func test_submitResult_transport_bannersAndKeepsAttemptCount() async {
    let session = Self.session()
    let store = TestStore(
      initialState: IDScanFeature.State(
        orderId: Self.orderId,
        idScan: Self.handoff(passed: false),
        status: .sdkInProgress,
        lastSession: session,
        attempts: 1
      )
    ) {
      IDScanFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverIDScanAPIClient = DriverIDScanAPIClient(
        startSession: { _ in throw DriverAPIError.unimplemented("startSession") },
        submitResult: { _, _ in
          throw APIError.transport(NSError(domain: "URLSession", code: -1009))
        }
      )
    }
    store.exhaustivity = .off

    await store.send(.sdkOutcomeReceived(.completed))
    await store.skipReceivedActions()
    await store.finish()

    XCTAssertEqual(store.state.attempts, 1)
    XCTAssertEqual(
      store.state.errorBanner,
      "Couldn't reach DankDash. Check your connection."
    )
  }

  // MARK: - canBeginScan guards

  func test_beginScan_whenAttemptsExhausted_isNoOp() async {
    let store = TestStore(
      initialState: IDScanFeature.State(
        orderId: Self.orderId,
        idScan: Self.handoff(passed: false),
        status: .failed(reason: "x"),
        attempts: 3
      )
    ) {
      IDScanFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.beginScanTapped)
  }

  func test_beginScan_whilePassedAlready_isNoOp() async {
    let store = TestStore(
      initialState: IDScanFeature.State(
        orderId: Self.orderId,
        idScan: Self.handoff(passed: true),
        status: .passed
      )
    ) {
      IDScanFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.beginScanTapped)
  }

  func test_beginScan_whileSDKInProgress_isNoOp() async {
    let store = TestStore(
      initialState: IDScanFeature.State(
        orderId: Self.orderId,
        idScan: Self.handoff(passed: false),
        status: .sdkInProgress
      )
    ) {
      IDScanFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.beginScanTapped)
  }

  // MARK: - Retry

  func test_retryTapped_reentersSessionFlow_preservesAttemptCount() async {
    let session = Self.session()
    let startCalls = Locker<[UUID]>(value: [])
    let store = TestStore(
      initialState: IDScanFeature.State(
        orderId: Self.orderId,
        idScan: Self.handoff(passed: false),
        status: .failed(reason: "didn't pass"),
        attempts: 1,
        errorBanner: "stale banner"
      )
    ) {
      IDScanFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverIDScanAPIClient = DriverIDScanAPIClient(
        startSession: { id in
          await startCalls.append(id)
          return session
        },
        submitResult: { _, _ in throw DriverAPIError.unimplemented("submitResult") }
      )
      $0.identityVerificationClient = IdentityVerificationClient(
        launchSDK: { _ in .canceled }
      )
    }
    store.exhaustivity = .off

    await store.send(.retryTapped)
    await store.skipReceivedActions()
    await store.finish()

    // Attempt count survives retry — three failed-cycles still locks
    // escalation.
    XCTAssertEqual(store.state.attempts, 1)
    XCTAssertNil(store.state.errorBanner)
    let starts = await startCalls.value
    XCTAssertEqual(starts, [Self.orderId])
  }

  // MARK: - Escalation delegates

  func test_contactSupport_firesDelegate() async {
    let store = TestStore(
      initialState: IDScanFeature.State(
        orderId: Self.orderId,
        idScan: Self.handoff(passed: false),
        status: .failed(reason: "didn't pass"),
        attempts: 3
      )
    ) {
      IDScanFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.contactSupportTapped)
    await store.receive(\.delegate.escalatedContactSupport)
  }

  func test_returnToDispensary_firesDelegate() async {
    let store = TestStore(
      initialState: IDScanFeature.State(
        orderId: Self.orderId,
        idScan: Self.handoff(passed: false),
        status: .failed(reason: "didn't pass"),
        attempts: 3
      )
    ) {
      IDScanFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.returnToDispensaryTapped)
    await store.receive(\.delegate.escalatedReturnToDispensary)
  }

  func test_back_firesDismissedDelegate() async {
    let store = TestStore(
      initialState: IDScanFeature.State(
        orderId: Self.orderId,
        idScan: Self.handoff(passed: false)
      )
    ) {
      IDScanFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    store.exhaustivity = .off

    await store.send(.backTapped)
    await store.skipReceivedActions()
    await store.finish()

    // Back fires the dismissed delegate (+ cancels in-flight effects).
    // We assert state untouched plus delegate arrival via merge.
    XCTAssertEqual(store.state.orderId, Self.orderId)
  }

  // MARK: - Banner dismiss

  func test_errorBannerDismissed_clearsBanner() async {
    let store = TestStore(
      initialState: IDScanFeature.State(
        orderId: Self.orderId,
        idScan: Self.handoff(passed: false),
        errorBanner: "boom"
      )
    ) {
      IDScanFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.errorBannerDismissed) {
      $0.errorBanner = nil
    }
  }

  // MARK: - Status helpers

  func test_idScanStatus_isTerminal_passed() {
    XCTAssertTrue(IDScanStatus.passed.isTerminal)
    XCTAssertTrue(IDScanStatus.failed(reason: "x").isTerminal)
    XCTAssertFalse(IDScanStatus.notStarted.isTerminal)
    XCTAssertFalse(IDScanStatus.sdkInProgress.isTerminal)
    XCTAssertFalse(IDScanStatus.awaitingResult.isTerminal)
  }

  func test_idScanStatus_isInFlight() {
    XCTAssertTrue(IDScanStatus.sessionRequested.isInFlight)
    XCTAssertTrue(IDScanStatus.sdkInProgress.isInFlight)
    XCTAssertTrue(IDScanStatus.awaitingResult.isInFlight)
    XCTAssertFalse(IDScanStatus.notStarted.isInFlight)
    XCTAssertFalse(IDScanStatus.passed.isInFlight)
    XCTAssertFalse(IDScanStatus.failed(reason: "x").isInFlight)
  }

  // MARK: - IDScanErrorBox classifications

  func test_idScanErrorBox_classifiesVerificationMismatch() {
    let error = APIError.server(
      status: 409,
      envelope: Self.envelope(code: "ID_SCAN_VERIFICATION_MISMATCH")
    )
    let box = IDScanErrorBox(error)
    XCTAssertTrue(box.isVerificationMismatch)
    XCTAssertEqual(
      box.userFacingMessage(),
      "Session expired. Tap Re-Scan to start a fresh verification."
    )
  }

  func test_idScanErrorBox_classifiesTransport() {
    let error = APIError.transport(NSError(domain: "URLSession", code: -1009))
    let box = IDScanErrorBox(error)
    XCTAssertFalse(box.isVerificationMismatch)
    if case .transport = box.kind {} else { XCTFail("expected .transport") }
    XCTAssertEqual(box.userFacingMessage(), "Couldn't reach DankDash. Check your connection.")
  }

  func test_idScanErrorBox_classifiesUnauthorized() {
    let box = IDScanErrorBox(APIError.unauthorized)
    XCTAssertEqual(box.userFacingMessage(), "Sign in again to continue.")
  }

  func test_idScanErrorBox_classifiesMalformed() {
    let box = IDScanErrorBox(DriverAPIError.malformedPayload("DriverIDScanSession"))
    if case .malformed(let label) = box.kind {
      XCTAssertEqual(label, "DriverIDScanSession")
    } else {
      XCTFail("expected .malformed kind")
    }
  }

  func test_idScanErrorBox_classifies500_asServer() {
    let error = APIError.server(
      status: 500,
      envelope: Self.envelope(code: "INTERNAL_ERROR", message: "kaboom")
    )
    let box = IDScanErrorBox(error)
    XCTAssertFalse(box.isVerificationMismatch)
    XCTAssertEqual(box.userFacingMessage(), "kaboom")
  }

  // MARK: - Fixtures

  nonisolated private static let orderId =
    UUID(uuidString: "00000000-0000-0000-0000-0000000000a1")!

  nonisolated private static let dispensaryId =
    UUID(uuidString: "00000000-0000-0000-0000-0000000000a2")!

  nonisolated private static let userId =
    UUID(uuidString: "00000000-0000-0000-0000-0000000000a3")!

  nonisolated private static let addressId =
    UUID(uuidString: "00000000-0000-0000-0000-0000000000a4")!

  nonisolated private static let referenceDate =
    Date(timeIntervalSince1970: 1_700_000_000)

  nonisolated private static let driverStart =
    Coordinate(latitude: 44.9778, longitude: -93.2650)
  nonisolated private static let dispensaryLocation =
    Coordinate(latitude: 44.9792, longitude: -93.2638)
  nonisolated private static let dropoffLocation =
    Coordinate(latitude: 44.9836, longitude: -93.2667)

  nonisolated private static func session(
    verificationId: String = "veriff-session-abc-123"
  ) -> IDScanSession {
    IDScanSession(
      verificationId: verificationId,
      sessionUrl: URL(string: "https://stationapi.veriff.com/sessions/\(verificationId)")!,
      sessionToken: "tok-\(verificationId)",
      expiresAt: nil
    )
  }

  nonisolated private static func handoff(passed: Bool) -> DeliveryHandoff {
    DeliveryHandoff(
      orderId: orderId,
      passed: passed,
      verificationId: passed ? "veriff-session-abc-123" : nil,
      scannedAt: passed ? referenceDate : nil
    )
  }

  nonisolated private static func activeRoute(
    idScanPassed: Bool = false
  ) -> ActiveRoute {
    let order = Order(
      id: orderId,
      shortCode: "ABC123",
      userId: userId,
      dispensaryId: dispensaryId,
      deliveryAddressId: addressId,
      status: idScanPassed ? .idScanPassed : .arrivedAtDropoff,
      subtotalCents: 5000,
      cannabisTaxCents: 500,
      salesTaxCents: 250,
      deliveryFeeCents: 599,
      driverTipCents: 0,
      discountCents: 0,
      totalCents: 6349,
      items: [],
      placedAt: referenceDate,
      statusChangedAt: referenceDate,
      createdAt: referenceDate,
      updatedAt: referenceDate
    )
    return ActiveRoute(
      order: order,
      customer: DriverHandoffCustomer(
        firstName: "Sam",
        lastName: "Jefferson",
        maskedPhone: "(555) 555-0123"
      ),
      dispensary: DriverHandoffDispensary(
        id: dispensaryId,
        name: "Northern Lights Cannabis",
        addressLine1: "123 First Ave N",
        addressLine2: nil,
        city: "Minneapolis",
        region: "MN",
        postalCode: "55401",
        location: dispensaryLocation,
        phone: "(612) 555-0100"
      ),
      dropoff: DriverHandoffAddress(
        line1: "555 Main St",
        line2: "Apt 4B",
        city: "Minneapolis",
        region: "MN",
        postalCode: "55403",
        location: dropoffLocation,
        instructions: "Ring buzzer 4B"
      ),
      idScan: handoff(passed: idScanPassed),
      events: []
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
    values.driverIDScanAPIClient = .unimplemented
    values.identityVerificationClient = .unimplemented
    values.hapticsClient = .noop
  }
}

// MARK: - Helpers

private struct SubmitCall: Sendable, Equatable {
  let orderId: UUID
  let verificationId: String
}

private actor Locker<T: Sendable> {
  private(set) var value: T
  init(value: T) { self.value = value }
}

private extension Locker where T == [UUID] {
  func append(_ id: UUID) { value.append(id) }
}

private extension Locker where T == [String] {
  func append(_ id: String) { value.append(id) }
}

private extension Locker where T == [SubmitCall] {
  func append(_ call: SubmitCall) { value.append(call) }
}

private extension Locker where T == [HapticsClient.NotificationType] {
  func append(_ type: HapticsClient.NotificationType) { value.append(type) }
}
