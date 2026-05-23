import XCTest
import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

@MainActor
final class DriverOnboardingFeatureTests: XCTestCase {

  // MARK: - Vehicle form

  func test_vehicleFormInputs_buildVehicle() {
    var state = DriverOnboardingFeature.State()
    XCTAssertFalse(state.isVehicleFormComplete)

    state.makeInput = "Honda"
    state.modelInput = "Civic"
    state.yearInput = "2021"
    state.plateInput = "ABC123"
    state.colorInput = "Blue"
    state.licenseNumberInput = "D-1234567"

    XCTAssertTrue(state.isVehicleFormComplete)
    XCTAssertTrue(state.isLicenseNumberValid)
    XCTAssertEqual(state.builtVehicle().make, "Honda")
    XCTAssertEqual(state.builtVehicle().year, 2021)
    XCTAssertEqual(state.builtVehicle().plate, "ABC123")
  }

  func test_yearInput_acceptsDigitsOnly() async {
    let store = TestStore(initialState: DriverOnboardingFeature.State()) {
      DriverOnboardingFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.yearChanged("20a21b")) { $0.yearInput = "2021" }
  }

  func test_plateInput_isUppercased() async {
    let store = TestStore(initialState: DriverOnboardingFeature.State()) {
      DriverOnboardingFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.plateChanged("abc123")) { $0.plateInput = "ABC123" }
  }

  // MARK: - Welcome → vehicle → documents

  func test_getStartedTapped_advancesToVehicle() async {
    let store = TestStore(initialState: DriverOnboardingFeature.State()) {
      DriverOnboardingFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.getStartedTapped) { $0.step = .vehicle }
  }

  func test_vehicleContinue_writesDraftAndAdvances() async {
    let writes = Locker<[DriverApplicationDraft]>(value: [])
    let store = TestStore(
      initialState: DriverOnboardingFeature.State(
        step: .vehicle,
        makeInput: "Honda",
        modelInput: "Civic",
        yearInput: "2021",
        plateInput: "ABC123",
        colorInput: "Blue",
        licenseNumberInput: "D-1234567"
      )
    ) {
      DriverOnboardingFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverApplicationDraftStoreClient = DriverApplicationDraftStoreClient(
        read: { nil },
        write: { draft in await writes.append(draft) },
        clear: {}
      )
      $0.date = .constant(Date(timeIntervalSince1970: 1_700_000_000))
    }

    await store.send(.vehicleContinueTapped) {
      $0.step = .documents
      $0.draft.vehicle = Vehicle(
        make: "Honda", model: "Civic", year: 2021, plate: "ABC123", color: "Blue"
      )
      $0.draft.licenseNumber = "D-1234567"
      $0.draft.updatedAt = Date(timeIntervalSince1970: 1_700_000_000)
    }
    await store.finish()
    let captured = await writes.value
    XCTAssertEqual(captured.count, 1)
    XCTAssertEqual(captured.first?.vehicle.make, "Honda")
  }

  func test_vehicleContinue_blocksOnIncompleteForm() async {
    let store = TestStore(
      initialState: DriverOnboardingFeature.State(
        step: .vehicle,
        makeInput: "Honda",
        modelInput: "",
        yearInput: "2021",
        plateInput: "ABC123",
        colorInput: "Blue",
        licenseNumberInput: "D-1234567"
      )
    ) {
      DriverOnboardingFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.vehicleContinueTapped) {
      $0.submissionError = "Fill out every field before continuing."
    }
  }

  // MARK: - Document picking

  func test_documentPicked_savesToDraftAndUpdatesState() async {
    let picked = PickedDocument(
      url: URL(fileURLWithPath: "/tmp/sample.pdf"),
      mimeType: "application/pdf",
      sizeBytes: 4096,
      capturedAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
    let savedURL = URL(fileURLWithPath: "/var/mobile/Containers/Data/Application/Drafts/license.pdf")
    let storedDocumentID = UUID(uuidString: "00000000-0000-0000-0000-0000000000aa")!

    let store = TestStore(initialState: DriverOnboardingFeature.State(step: .documents)) {
      DriverOnboardingFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.documentPickerClient = .test(picked)
      $0.documentDraftStoreClient = DocumentDraftStoreClient(
        saveDocument: { _, _, _, _, _, _, _ in savedURL },
        removeDocument: { _, _ in },
        clear: { _ in },
        clearAll: {}
      )
      $0.uuid = .constant(storedDocumentID)
      $0.date = .constant(Date(timeIntervalSince1970: 1_700_000_000))
    }

    await store.send(.documentRowTapped(.vehicleInsurance)) {
      $0.slotUploadStates[.vehicleInsurance] = .uploading
    }
    await store.receive(\.documentPicked)
    await store.receive(\.documentSaved) {
      $0.draft.documents[.vehicleInsurance] = DraftDocument(
        id: storedDocumentID,
        slot: .vehicleInsurance,
        localFileURL: savedURL,
        mimeType: "application/pdf",
        capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
        sizeBytes: 4096
      )
      $0.draft.updatedAt = Date(timeIntervalSince1970: 1_700_000_000)
      $0.slotUploadStates[.vehicleInsurance] = .uploaded
    }
    await store.finish()
  }

  func test_documentPicked_cancelledLeavesSlotIdle() async {
    let store = TestStore(initialState: DriverOnboardingFeature.State(step: .documents)) {
      DriverOnboardingFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.documentPickerClient = .failing(.cancelled)
    }

    await store.send(.documentRowTapped(.driversLicense)) {
      $0.slotUploadStates[.driversLicense] = .uploading
    }
    await store.receive(\.documentPickFailed) {
      $0.slotUploadStates[.driversLicense] = .idle
    }
  }

  func test_documentsContinue_requiresAllSlots() async {
    let store = TestStore(
      initialState: DriverOnboardingFeature.State(
        step: .documents,
        draft: Self.completeDraft(missingSlot: .vehicleRegistration)
      )
    ) {
      DriverOnboardingFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.documentsContinueTapped) {
      $0.submissionError = "Upload every required document before continuing."
    }
  }

  func test_documentsContinue_advancesWhenComplete() async {
    let store = TestStore(
      initialState: DriverOnboardingFeature.State(
        step: .documents,
        draft: Self.completeDraft()
      )
    ) {
      DriverOnboardingFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.documentsContinueTapped) { $0.step = .review }
  }

  // MARK: - Submission

  func test_submission_success_clearsDraftAndStartsPolling() async {
    let submission = DriverApplicationSubmission(
      applicationId: UUID(),
      status: "pending",
      queuePosition: 3
    )
    let clearedCount = Locker<Int>(value: 0)
    let clock = TestClock()

    let store = TestStore(
      initialState: DriverOnboardingFeature.State(
        step: .review,
        draft: Self.completeDraft()
      )
    ) {
      DriverOnboardingFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOnboardingAPIClient = DriverOnboardingAPIClient(
        submitApplication: { _ in submission }
      )
      $0.driverApplicationDraftStoreClient = DriverApplicationDraftStoreClient(
        read: { nil },
        write: { _ in },
        clear: { await clearedCount.increment() }
      )
      $0.driverAppAPIClient = .unimplemented
      $0.continuousClock = clock
    }

    await store.send(.reviewSubmitTapped) { $0.isSubmittingDraft = true }
    await store.receive(\.submissionResponse.success) {
      $0.isSubmittingDraft = false
      $0.submission = submission
      $0.step = .pending
    }

    // Tick the clock once to consume the 30-second polling timer; the
    // poll call will fail (unimplemented driverAppAPIClient throws
    // .unimplemented), which surfaces as a non-endpointNotYetAvailable
    // poll error that the reducer surfaces as a generic message.
    await clock.advance(by: .seconds(30))
    await store.receive(\.pendingPollTriggered)
    await store.receive(\.pendingPollResponse.failure) {
      $0.pendingPollError = "unimplemented(\"getMe\")"
    }

    let cleared = await clearedCount.value
    XCTAssertEqual(cleared, 1, "submit-success should clear the draft once")

    await store.send(.delegate(.onboardingComplete(Self.passedDriver())))
    await store.finish()
  }

  func test_submission_endpointNotYetAvailable_landsOnPendingQueued() async {
    let clock = TestClock()
    let store = TestStore(
      initialState: DriverOnboardingFeature.State(
        step: .review,
        draft: Self.completeDraft()
      )
    ) {
      DriverOnboardingFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOnboardingAPIClient = DriverOnboardingAPIClient(
        submitApplication: { _ in throw DriverOnboardingAPIError.endpointNotYetAvailable }
      )
      $0.driverAppAPIClient = .unimplemented
      $0.continuousClock = clock
    }

    await store.send(.reviewSubmitTapped) { $0.isSubmittingDraft = true }
    await store.receive(\.submissionResponse.failure) {
      $0.isSubmittingDraft = false
      $0.queuedForOps = true
      $0.step = .pending
    }
    await store.send(.delegate(.onboardingComplete(Self.passedDriver())))
    await store.finish()
  }

  func test_submission_serverError_surfacesMessage() async {
    let envelope = ErrorEnvelope(error: .init(code: "BAD_REQUEST", message: "Invalid plate format"))
    let store = TestStore(
      initialState: DriverOnboardingFeature.State(
        step: .review,
        draft: Self.completeDraft()
      )
    ) {
      DriverOnboardingFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOnboardingAPIClient = DriverOnboardingAPIClient(
        submitApplication: { _ in throw APIError.server(status: 400, envelope: envelope) }
      )
    }
    await store.send(.reviewSubmitTapped) { $0.isSubmittingDraft = true }
    await store.receive(\.submissionResponse.failure) {
      $0.isSubmittingDraft = false
      $0.submissionError = "Invalid plate format"
    }
  }

  // MARK: - Pending polling

  func test_pendingPoll_passedDriver_firesDelegate() async {
    let driver = Self.passedDriver()
    let store = TestStore(
      initialState: DriverOnboardingFeature.State(step: .pending, queuedForOps: true)
    ) {
      DriverOnboardingFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverAppAPIClient = DriverAppAPIClient(
        getMe: { driver },
        getCurrentRoute: { throw DriverAPIError.unimplemented("getCurrentRoute") },
        getEarnings: { _ in throw DriverAPIError.unimplemented("getEarnings") },
        getShifts: { throw DriverAPIError.unimplemented("getShifts") }
      )
    }

    await store.send(.pendingRefreshTapped)
    await store.receive(\.pendingPollResponse.success) { $0.driver = driver }
    await store.receive(\.delegate.onboardingComplete)
  }

  func test_pendingPoll_endpointNotYetAvailable_isSilent() async {
    let store = TestStore(
      initialState: DriverOnboardingFeature.State(step: .pending, queuedForOps: true)
    ) {
      DriverOnboardingFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverAppAPIClient = DriverAppAPIClient(
        getMe: { throw DriverAppAPIError.endpointNotYetAvailable },
        getCurrentRoute: { throw DriverAPIError.unimplemented("getCurrentRoute") },
        getEarnings: { _ in throw DriverAPIError.unimplemented("getEarnings") },
        getShifts: { throw DriverAPIError.unimplemented("getShifts") }
      )
    }

    await store.send(.pendingRefreshTapped)
    await store.receive(\.pendingPollResponse.failure)
    // No state change — pendingPollError stays nil.
  }

  // MARK: - Hydration

  func test_onAppear_hydratesFromPersistedDraft() async {
    let stored = DriverApplicationDraft(
      id: UUID(),
      vehicle: Vehicle(make: "Honda", model: "Civic", year: 2021, plate: "ABC123", color: "Blue"),
      licenseNumber: "D-1234567",
      documents: [:],
      createdAt: Date(timeIntervalSince1970: 1_700_000_000),
      updatedAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
    let store = TestStore(initialState: DriverOnboardingFeature.State()) {
      DriverOnboardingFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverApplicationDraftStoreClient = DriverApplicationDraftStoreClient(
        read: { stored },
        write: { _ in },
        clear: {}
      )
    }

    await store.send(.onAppear)
    await store.receive(\.draftHydrated) {
      $0.draft = stored
      $0.makeInput = "Honda"
      $0.modelInput = "Civic"
      $0.yearInput = "2021"
      $0.plateInput = "ABC123"
      $0.colorInput = "Blue"
      $0.licenseNumberInput = "D-1234567"
      $0.slotUploadStates = [
        .driversLicense: .idle,
        .vehicleInsurance: .idle,
        .vehicleRegistration: .idle,
      ]
      $0.step = .documents
    }
  }

  func test_onAppear_noStoredDraft_keepsWelcomeStep() async {
    let store = TestStore(initialState: DriverOnboardingFeature.State()) {
      DriverOnboardingFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverApplicationDraftStoreClient = DriverApplicationDraftStoreClient(
        read: { nil },
        write: { _ in },
        clear: {}
      )
    }

    await store.send(.onAppear)
    await store.receive(\.draftHydrated)
    XCTAssertEqual(store.state.step, .welcome)
  }

  // MARK: - Navigation

  func test_backTapped_walksThroughSteps() async {
    let store = TestStore(initialState: DriverOnboardingFeature.State(step: .review)) {
      DriverOnboardingFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.backTapped) { $0.step = .documents }
    await store.send(.backTapped) { $0.step = .vehicle }
    await store.send(.backTapped) { $0.step = .welcome }
    await store.send(.backTapped) // welcome → no-op
    XCTAssertEqual(store.state.step, .welcome)
  }

  func test_pendingStep_backIsNoOp() async {
    let store = TestStore(initialState: DriverOnboardingFeature.State(step: .pending)) {
      DriverOnboardingFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.backTapped)
    XCTAssertEqual(store.state.step, .pending)
  }

  // MARK: - Step indicator

  func test_currentStepIndex_pendingStaysOnReviewIndex() {
    XCTAssertEqual(DriverOnboardingFeature.State(step: .welcome).currentStepIndex, 0)
    XCTAssertEqual(DriverOnboardingFeature.State(step: .vehicle).currentStepIndex, 1)
    XCTAssertEqual(DriverOnboardingFeature.State(step: .documents).currentStepIndex, 2)
    XCTAssertEqual(DriverOnboardingFeature.State(step: .review).currentStepIndex, 3)
    XCTAssertEqual(DriverOnboardingFeature.State(step: .pending).currentStepIndex, 3)
  }

  // MARK: - Fixtures

  private static func completeDraft(missingSlot: DocumentSlot? = nil) -> DriverApplicationDraft {
    var docs: [DocumentSlot: DraftDocument] = [:]
    for slot in DocumentSlot.allCases where slot != missingSlot {
      docs[slot] = DraftDocument(
        id: UUID(),
        slot: slot,
        localFileURL: URL(fileURLWithPath: "/tmp/\(slot.rawValue).pdf"),
        mimeType: "application/pdf",
        capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
        sizeBytes: 4096
      )
    }
    return DriverApplicationDraft(
      id: UUID(),
      vehicle: Vehicle(make: "Honda", model: "Civic", year: 2021, plate: "ABC123", color: "Blue"),
      licenseNumber: "D-1234567",
      documents: docs,
      createdAt: Date(timeIntervalSince1970: 1_700_000_000),
      updatedAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
  }

  private static func passedDriver() -> Driver {
    Driver(
      id: UUID(),
      userId: UUID(),
      vehicle: Vehicle(make: "Honda", model: "Civic", year: 2021, plate: "ABC123", color: "Blue"),
      insuranceDocKey: nil,
      insuranceExpiresAt: nil,
      backgroundCheckPassedAt: "2024-01-15T12:00:00Z",
      backgroundCheckProviderRef: "veriff-session-abc",
      currentStatus: .offline,
      lastStatusChangeAt: Date(timeIntervalSince1970: 1_700_000_000),
      currentLocation: nil,
      currentLocationUpdatedAt: nil,
      currentOrderId: nil,
      ratingAvg: nil,
      ratingCount: 0,
      totalDeliveries: 0,
      createdAt: Date(timeIntervalSince1970: 1_700_000_000),
      updatedAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
  }

  /// Sets the dependency clients to safe stubs so that an unintended
  /// effect call surfaces as a TestStore "unexpected action" instead of
  /// hitting the live binding.
  static func disableDependencies(_ values: inout DependencyValues) {
    values.driverApplicationDraftStoreClient = .unimplemented
    values.documentDraftStoreClient = .unimplemented
    values.documentPickerClient = .unimplemented
    values.driverOnboardingAPIClient = .unimplemented
    values.driverAppAPIClient = .unimplemented
    values.uuid = .incrementing
    values.date = .constant(Date(timeIntervalSince1970: 1_700_000_000))
    values.continuousClock = ImmediateClock()
  }
}

// MARK: - Helpers

private actor Locker<T: Sendable> {
  private(set) var value: T
  init(value: T) { self.value = value }
  func set(_ newValue: T) { self.value = newValue }
}

private extension Locker where T == [DriverApplicationDraft] {
  func append(_ draft: DriverApplicationDraft) {
    value.append(draft)
  }
}

private extension Locker where T == Int {
  func increment() { value += 1 }
}
