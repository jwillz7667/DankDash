import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Driver-self onboarding flow. The flow is four screens, plus a
/// terminal "pending review" screen the user lands on once submission
/// completes:
///
///   welcome → vehicle → documents → review → pending
///
/// Two backend gaps are tolerated gracefully here (both documented in
/// the Phase 19 plan):
///
/// - `POST /v1/driver/applications` is not yet built. On submit, a 404
///   surfaces as ``DriverOnboardingAPIError.endpointNotYetAvailable``;
///   the reducer treats this as success-with-flag and routes the user
///   to the pending screen with `queuedForOps = true` so the copy
///   reads "queued — admin will reach out" rather than "submitted —
///   we're reviewing your documents".
/// - `GET /v1/driver/me` is not yet built. On the pending screen the
///   reducer polls `getMe` every 30s; a 404 surfaces as
///   ``DriverAppAPIError.endpointNotYetAvailable``, which the polling
///   loop silently swallows (the driver record doesn't exist yet, so
///   there is nothing to surface).
@Reducer
public struct DriverOnboardingFeature: Sendable {
  public enum Step: Sendable, Equatable {
    case welcome
    case vehicle
    case documents
    case review
    case pending
  }

  @ObservableState
  public struct State: Equatable, Sendable {
    public var step: Step
    public var draft: DriverApplicationDraft
    /// Bound to the vehicle form's inputs (kept as strings so the form
    /// can render in-progress edits like "20" before "2021").
    public var makeInput: String
    public var modelInput: String
    public var yearInput: String
    public var plateInput: String
    public var colorInput: String
    public var licenseNumberInput: String
    public var slotUploadStates: [DocumentSlot: SlotUploadState]
    public var isSubmittingDraft: Bool
    public var submissionError: String?
    /// True when the backend's onboarding endpoint isn't built yet —
    /// surfaces the "queued — admin will reach out" copy on the pending
    /// screen.
    public var queuedForOps: Bool
    public var submission: DriverApplicationSubmission?
    public var driver: Driver?
    public var pendingPollError: String?

    public init(
      step: Step? = nil,
      draft: DriverApplicationDraft = DriverApplicationDraft(),
      makeInput: String = "",
      modelInput: String = "",
      yearInput: String = "",
      plateInput: String = "",
      colorInput: String = "",
      licenseNumberInput: String = "",
      slotUploadStates: [DocumentSlot: SlotUploadState] = [:],
      isSubmittingDraft: Bool = false,
      submissionError: String? = nil,
      queuedForOps: Bool = false,
      submission: DriverApplicationSubmission? = nil,
      driver: Driver? = nil,
      pendingPollError: String? = nil
    ) {
      // A driver row already exists (the root reducer hands one in when
      // `GET /v1/driver/me` returns a not-yet-cleared driver) → the
      // application is already submitted, so land directly on the
      // pending screen rather than the welcome step. An explicit `step`
      // still wins, so the form steps and tests stay addressable.
      self.step = step ?? (driver == nil ? .welcome : .pending)
      self.draft = draft
      self.makeInput = makeInput
      self.modelInput = modelInput
      self.yearInput = yearInput
      self.plateInput = plateInput
      self.colorInput = colorInput
      self.licenseNumberInput = licenseNumberInput
      self.slotUploadStates = slotUploadStates
      self.isSubmittingDraft = isSubmittingDraft
      self.submissionError = submissionError
      self.queuedForOps = queuedForOps
      self.submission = submission
      self.driver = driver
      self.pendingPollError = pendingPollError
    }

    public enum SlotUploadState: Equatable, Sendable {
      case idle
      case uploading
      case uploaded
      case failed(reason: String)
    }

    public var isVehicleFormComplete: Bool {
      builtVehicle().isComplete
    }

    public var isLicenseNumberValid: Bool {
      !licenseNumberInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public var documentsCompleted: Bool {
      DocumentSlot.allCases.allSatisfy { draft.documents[$0] != nil }
    }

    public var canSubmitApplication: Bool {
      !isSubmittingDraft && draft.isReadyToSubmit
    }

    public var validationIssues: [DriverApplicationDraft.ValidationIssue] {
      draft.validate()
    }

    public var currentStepIndex: Int {
      switch step {
      case .welcome: 0
      case .vehicle: 1
      case .documents: 2
      case .review: 3
      case .pending: 3
      }
    }

    public static let totalSteps = 4

    /// Builds a candidate ``Vehicle`` from the current form inputs.
    /// Trims whitespace and parses the year as Int; empty strings turn
    /// into nil so `Vehicle.isComplete` correctly reports incomplete.
    public func builtVehicle() -> Vehicle {
      Vehicle(
        make: trimmedOrNil(makeInput),
        model: trimmedOrNil(modelInput),
        year: Int(yearInput.trimmingCharacters(in: .whitespacesAndNewlines)),
        plate: trimmedOrNil(plateInput),
        color: trimmedOrNil(colorInput)
      )
    }

    private func trimmedOrNil(_ value: String) -> String? {
      let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
      return trimmed.isEmpty ? nil : trimmed
    }
  }

  public enum Action: Equatable, Sendable {
    case onAppear
    case draftHydrated(DriverApplicationDraft?)

    // Vehicle form
    case makeChanged(String)
    case modelChanged(String)
    case yearChanged(String)
    case plateChanged(String)
    case colorChanged(String)
    case licenseNumberChanged(String)

    // Navigation
    case getStartedTapped
    case vehicleContinueTapped
    case documentsContinueTapped
    case reviewSubmitTapped
    case backTapped

    // Document upload
    case documentRowTapped(DocumentSlot)
    case documentPicked(slot: DocumentSlot, document: PickedDocument)
    case documentPickFailed(slot: DocumentSlot, error: PickerErrorBox)
    case documentSaved(slot: DocumentSlot, document: DraftDocument)
    case documentSaveFailed(slot: DocumentSlot, error: DraftErrorBox)
    case documentRemoveTapped(DocumentSlot)

    // Submission
    case submissionResponse(Result<DriverApplicationSubmission, SubmissionErrorBox>)

    // Pending-screen polling
    case pendingPollTriggered
    case pendingPollResponse(Result<Driver, PollErrorBox>)
    case pendingRefreshTapped

    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Equatable, Sendable {
      case onboardingComplete(Driver)
    }
  }

  @Dependency(\.driverApplicationDraftStoreClient) var draftStore
  @Dependency(\.documentDraftStoreClient) var documentStore
  @Dependency(\.documentPickerClient) var documentPicker
  @Dependency(\.driverOnboardingAPIClient) var onboardingAPI
  @Dependency(\.driverAppAPIClient) var driverAppAPI
  @Dependency(\.uuid) var uuid
  @Dependency(\.date.now) var now
  @Dependency(\.continuousClock) var clock

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .onAppear:
        // Re-entry with an already-submitted (pending) driver row: the
        // form is behind us, so skip draft hydration entirely and resume
        // on the pending screen. Poll once immediately — an admin may
        // have cleared the background check while the app was closed —
        // then keep the 30s loop running so the screen flips to the
        // shift home the moment approval lands.
        if state.driver != nil {
          state.step = .pending
          return .merge(
            .send(.pendingPollTriggered),
            pollingEffect()
          )
        }
        // Hydrate state from any persisted draft so a cold relaunch
        // resumes the user at the same step.
        return .run { send in
          let stored = await draftStore.read()
          await send(.draftHydrated(stored))
        }

      case .draftHydrated(let stored):
        guard let stored else { return .none }
        state.draft = stored
        state.makeInput = stored.vehicle.make ?? ""
        state.modelInput = stored.vehicle.model ?? ""
        state.yearInput = stored.vehicle.year.map(String.init) ?? ""
        state.plateInput = stored.vehicle.plate ?? ""
        state.colorInput = stored.vehicle.color ?? ""
        state.licenseNumberInput = stored.licenseNumber
        // Mark already-uploaded slots so the document list reflects the
        // resumed state when the user returns.
        for slot in DocumentSlot.allCases {
          state.slotUploadStates[slot] = stored.documents[slot] != nil ? .uploaded : .idle
        }
        // Resume at the furthest step the draft data supports.
        if stored.documents.count == DocumentSlot.allCases.count {
          state.step = .review
        } else if stored.vehicle.isComplete && !stored.licenseNumber.isEmpty {
          state.step = .documents
        } else {
          state.step = .vehicle
        }
        return .none

      case .makeChanged(let value):
        state.makeInput = value
        state.submissionError = nil
        return .none
      case .modelChanged(let value):
        state.modelInput = value
        state.submissionError = nil
        return .none
      case .yearChanged(let value):
        state.yearInput = value.filter(\.isNumber)
        state.submissionError = nil
        return .none
      case .plateChanged(let value):
        state.plateInput = value.uppercased()
        state.submissionError = nil
        return .none
      case .colorChanged(let value):
        state.colorInput = value
        state.submissionError = nil
        return .none
      case .licenseNumberChanged(let value):
        state.licenseNumberInput = value
        state.submissionError = nil
        return .none

      case .getStartedTapped:
        state.step = .vehicle
        return .none

      case .vehicleContinueTapped:
        let vehicle = state.builtVehicle()
        guard vehicle.isComplete, state.isLicenseNumberValid else {
          state.submissionError = "Fill out every field before continuing."
          return .none
        }
        state.draft.vehicle = vehicle
        state.draft.licenseNumber = state.licenseNumberInput.trimmingCharacters(in: .whitespacesAndNewlines)
        state.draft.updatedAt = now
        state.step = .documents
        return .run { [draft = state.draft] _ in
          try? await draftStore.write(draft)
        }

      case .documentsContinueTapped:
        guard state.documentsCompleted else {
          state.submissionError = "Upload every required document before continuing."
          return .none
        }
        state.step = .review
        return .none

      case .documentRowTapped(let slot):
        state.slotUploadStates[slot] = .uploading
        state.submissionError = nil
        let source: DocumentPickerSource = slot == .driversLicense
          ? .photoLibrary
          : .files
        return .run { send in
          do {
            let picked = try await documentPicker.pick(source)
            await send(.documentPicked(slot: slot, document: picked))
          } catch {
            await send(.documentPickFailed(slot: slot, error: PickerErrorBox(error)))
          }
        }

      case let .documentPicked(slot, picked):
        let draftId = state.draft.id
        let documentId = uuid()
        let captured = picked.capturedAt
        let mime = picked.mimeType
        let size = picked.sizeBytes
        let sourceURL = picked.url
        return .run { send in
          do {
            let stored = try await documentStore.saveDocument(
              draftId,
              documentId,
              slot,
              sourceURL,
              mime,
              captured,
              size
            )
            let doc = DraftDocument(
              id: documentId,
              slot: slot,
              localFileURL: stored,
              mimeType: mime,
              capturedAt: captured,
              sizeBytes: size
            )
            await send(.documentSaved(slot: slot, document: doc))
          } catch {
            await send(.documentSaveFailed(slot: slot, error: DraftErrorBox(error)))
          }
        }

      case let .documentPickFailed(slot, box):
        switch box.kind {
        case .cancelled:
          state.slotUploadStates[slot] = .idle
        case .unavailable:
          state.slotUploadStates[slot] = .failed(reason: "Picker unavailable on this device.")
        case .unsupportedType(let label):
          state.slotUploadStates[slot] = .failed(reason: "Unsupported file type: \(label).")
        case .underlying(let message):
          state.slotUploadStates[slot] = .failed(reason: message)
        }
        return .none

      case let .documentSaved(slot, doc):
        state.draft.documents[slot] = doc
        state.draft.updatedAt = now
        state.slotUploadStates[slot] = .uploaded
        return .run { [draft = state.draft] _ in
          try? await draftStore.write(draft)
        }

      case let .documentSaveFailed(slot, box):
        state.slotUploadStates[slot] = .failed(reason: box.userFacingMessage())
        return .none

      case .documentRemoveTapped(let slot):
        state.draft.documents.removeValue(forKey: slot)
        state.draft.updatedAt = now
        state.slotUploadStates[slot] = .idle
        let draftId = state.draft.id
        return .run { [draft = state.draft] _ in
          try? await documentStore.removeDocument(draftId, slot)
          try? await draftStore.write(draft)
        }

      case .backTapped:
        switch state.step {
        case .vehicle: state.step = .welcome
        case .documents: state.step = .vehicle
        case .review: state.step = .documents
        case .welcome, .pending: break
        }
        return .none

      case .reviewSubmitTapped:
        guard state.canSubmitApplication else { return .none }
        state.isSubmittingDraft = true
        state.submissionError = nil
        let draft = state.draft
        return .run { send in
          do {
            let submission = try await onboardingAPI.submitApplication(draft)
            await send(.submissionResponse(.success(submission)))
          } catch {
            await send(.submissionResponse(.failure(SubmissionErrorBox(error))))
          }
        }

      case .submissionResponse(.success(let submission)):
        state.isSubmittingDraft = false
        state.submission = submission
        state.queuedForOps = false
        state.step = .pending
        return .merge(
          .run { _ in try? await draftStore.clear() },
          pollingEffect()
        )

      case .submissionResponse(.failure(let box)):
        state.isSubmittingDraft = false
        if box.endpointNotYetAvailable {
          // Treat the missing endpoint as a queued submission. The
          // draft stays on disk so we can resubmit it once the
          // endpoint lands.
          state.queuedForOps = true
          state.submissionError = nil
          state.step = .pending
          return pollingEffect()
        }
        state.submissionError = box.userFacingMessage()
        return .none

      case .pendingPollTriggered, .pendingRefreshTapped:
        guard state.step == .pending else { return .none }
        return .run { send in
          do {
            let driver = try await driverAppAPI.getMe()
            await send(.pendingPollResponse(.success(driver)))
          } catch {
            await send(.pendingPollResponse(.failure(PollErrorBox(error))))
          }
        }

      case .pendingPollResponse(.success(let driver)):
        state.driver = driver
        state.pendingPollError = nil
        if driver.isBackgroundCheckPassed {
          return .send(.delegate(.onboardingComplete(driver)))
        }
        return .none

      case .pendingPollResponse(.failure(let box)):
        if box.endpointNotYetAvailable {
          // No driver record yet — pending screen stays put. We don't
          // surface this as an error; it's the expected state until the
          // backend endpoint lands.
          state.pendingPollError = nil
          return .none
        }
        state.pendingPollError = box.userFacingMessage()
        return .none

      case .delegate(.onboardingComplete):
        return .cancel(id: PollCancelID.poll)
      }
    }
  }

  /// 30-second polling loop that fires the same `pendingPollTriggered`
  /// action over and over while the user stays on the pending screen.
  /// Cancellable so a delegate-driven exit (or a navigation away) tears
  /// the timer down.
  private func pollingEffect() -> Effect<Action> {
    .run { send in
      for await _ in clock.timer(interval: .seconds(30)) {
        await send(.pendingPollTriggered)
      }
    }
    .cancellable(id: PollCancelID.poll, cancelInFlight: true)
  }

  public enum PollCancelID: Hashable, Sendable {
    case poll
  }
}

// MARK: - Error boxes

public struct PickerErrorBox: Error, Equatable, Sendable {
  public enum Kind: Equatable, Sendable {
    case cancelled
    case unavailable
    case unsupportedType(String)
    case underlying(String)
  }

  public let kind: Kind

  public init(_ error: Error) {
    if let pickerError = error as? DocumentPickerClientError {
      switch pickerError {
      case .cancelled: self.kind = .cancelled
      case .unavailable: self.kind = .unavailable
      case .unsupportedType(let label): self.kind = .unsupportedType(label)
      case .underlying(let message): self.kind = .underlying(message)
      }
    } else {
      self.kind = .underlying(String(describing: error))
    }
  }
}

public struct DraftErrorBox: Error, Equatable, Sendable {
  public let message: String

  public init(_ error: Error) {
    self.message = String(describing: error)
  }

  public func userFacingMessage() -> String {
    "Could not save your file. Try again."
  }
}

public struct SubmissionErrorBox: Error, Equatable, Sendable {
  public enum Kind: Equatable, Sendable {
    case endpointNotYetAvailable
    case draftIncomplete
    case server(message: String)
    case transport
    case other(String)
  }

  public let kind: Kind

  public init(_ error: Error) {
    if let onboardingError = error as? DriverOnboardingAPIError {
      switch onboardingError {
      case .endpointNotYetAvailable: self.kind = .endpointNotYetAvailable
      case .draftIncomplete: self.kind = .draftIncomplete
      }
      return
    }
    if let apiError = error as? APIError {
      switch apiError {
      case .server(_, let envelope): self.kind = .server(message: envelope.error.message)
      case .transport: self.kind = .transport
      case .unauthorized, .noRefreshToken: self.kind = .other("Sign in again to submit.")
      case .unexpectedStatus, .decoding, .configuration: self.kind = .other(String(describing: apiError))
      }
      return
    }
    self.kind = .other(String(describing: error))
  }

  public var endpointNotYetAvailable: Bool {
    if case .endpointNotYetAvailable = kind { return true }
    return false
  }

  public func userFacingMessage() -> String {
    switch kind {
    case .endpointNotYetAvailable: "Your application is queued. We'll review it shortly."
    case .draftIncomplete: "Some information is missing. Go back and review your details."
    case .server(let message): message
    case .transport: "Couldn't reach DankDash. Check your connection."
    case .other(let message): message
    }
  }
}

public struct PollErrorBox: Error, Equatable, Sendable {
  public enum Kind: Equatable, Sendable {
    case endpointNotYetAvailable
    case transport
    case other(String)
  }

  public let kind: Kind

  public init(_ error: Error) {
    if let appError = error as? DriverAppAPIError {
      switch appError {
      case .endpointNotYetAvailable: self.kind = .endpointNotYetAvailable
      }
      return
    }
    if let apiError = error as? APIError {
      switch apiError {
      case .transport: self.kind = .transport
      default: self.kind = .other(String(describing: apiError))
      }
      return
    }
    self.kind = .other(String(describing: error))
  }

  public var endpointNotYetAvailable: Bool {
    if case .endpointNotYetAvailable = kind { return true }
    return false
  }

  public func userFacingMessage() -> String {
    switch kind {
    case .endpointNotYetAvailable: ""
    case .transport: "Couldn't reach DankDash. We'll try again."
    case .other(let message): message
    }
  }
}
