import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Driver ID-scan handoff screen. Orchestrates the Veriff session →
/// SDK launch → backend submit-result chain that gates the
/// `delivery-confirm` POST.
///
/// Compliance note: this reducer is the iOS half of a hard-non-
/// bypassable gate. The DELIVERED transition is blocked server-side
/// inside `OrdersRepository.transitionStatus` when
/// `delivery_id_scan_passed != true`. Even if every action here is
/// short-circuited, the order cannot move to `delivered`. This screen
/// is a usability surface, not a security boundary — its job is to
/// guide the driver through Veriff without dead-ends.
///
/// Retry budget: three real verification attempts. A "real attempt"
/// is the SDK reaching a `.completed` or `.error` outcome — a user
/// cancel (`.canceled`) does NOT consume an attempt. After three
/// failures the screen surfaces three escalation CTAs in place of
/// Re-Scan: Contact Support, Return to Dispensary, Back.
@Reducer
public struct IDScanFeature: Sendable {
  /// Three real attempts before escalation. Hardcoded because changing
  /// the limit is a product-policy call, not a tuning knob — bump
  /// here only if compliance + ops both sign off.
  public static let maxAttempts: Int = 3

  @ObservableState
  public struct State: Equatable, Sendable, Identifiable {
    public var orderId: UUID
    public var idScan: DeliveryHandoff
    public var status: IDScanStatus
    public var lastSession: IDScanSession?
    public var attempts: Int
    public var errorBanner: String?
    public var route: ActiveRoute?

    public var id: UUID { orderId }

    public init(
      orderId: UUID,
      idScan: DeliveryHandoff,
      status: IDScanStatus = .notStarted,
      lastSession: IDScanSession? = nil,
      attempts: Int = 0,
      errorBanner: String? = nil,
      route: ActiveRoute? = nil
    ) {
      self.orderId = orderId
      self.idScan = idScan
      self.status = status
      self.lastSession = lastSession
      self.attempts = attempts
      self.errorBanner = errorBanner
      self.route = route
    }

    /// Whether the Begin Scan / Re-Scan CTA is tappable. Disabled while
    /// any leg of the flow is in-flight, after a pass, or after the
    /// retry budget is spent.
    public var canBeginScan: Bool {
      !status.isInFlight && status != .passed && attempts < IDScanFeature.maxAttempts
    }

    /// `true` once the driver has used the entire retry budget without
    /// a passing decision. The UI swaps Re-Scan for the three
    /// escalation CTAs at this point.
    public var shouldShowEscalation: Bool {
      attempts >= IDScanFeature.maxAttempts && status != .passed
    }

    /// `true` when the scan has passed and the parent should advance
    /// to Delivery Complete. The reducer fires the delegate as soon as
    /// this becomes true, but the computed property is also surfaced
    /// for the view's CTA enablement.
    public var hasPassed: Bool {
      status == .passed
    }
  }

  public enum Action: Equatable, Sendable {
    case onAppear
    case beginScanTapped
    case retryTapped

    case sessionStarted(Result<IDScanSession, IDScanErrorBox>)
    case sdkOutcomeReceived(IDScanSDKOutcome)
    case resultSubmitted(Result<ActiveRoute, IDScanErrorBox>)

    case errorBannerDismissed
    case contactSupportTapped
    case returnToDispensaryTapped
    case backTapped

    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Equatable, Sendable {
      /// Scan passed. The parent should push Delivery Complete with the
      /// hydrated handoff (the verificationId is the server-side proof
      /// the delivery-confirm POST will reference).
      case confirmed(orderId: UUID, idScan: DeliveryHandoff)
      /// User backed out without completing.
      case dismissed(orderId: UUID)
      /// Driver tapped Contact Support after exhausting retries — the
      /// parent owns the support intent (in-app form, dialer, etc).
      case escalatedContactSupport(orderId: UUID)
      /// Driver tapped Return to Dispensary — parent should pop to the
      /// shift home + present a follow-up sheet (or route an ops
      /// notification — that decision lives at the parent layer).
      case escalatedReturnToDispensary(orderId: UUID)
    }
  }

  public enum CancelID: Hashable, Sendable {
    case startSession
    case sdkLaunch
    case submitResult
  }

  @Dependency(\.driverIDScanAPIClient) var idScanAPI
  @Dependency(\.identityVerificationClient) var identityClient
  @Dependency(\.hapticsClient) var haptics

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .onAppear:
        // Defensive: the parent may have lazily pushed this screen for
        // an order whose scan already passed (deep-link / re-launch
        // after a backend reconciliation). Fire the delegate so the
        // parent advances immediately rather than rendering a stale
        // "Begin Scan" CTA on top of a passed order.
        if state.idScan.passed {
          state.status = .passed
          return .send(.delegate(.confirmed(orderId: state.orderId, idScan: state.idScan)))
        }
        return .none

      case .beginScanTapped:
        guard state.canBeginScan else { return .none }
        return startSession(state: &state)

      case .retryTapped:
        // Retry resets the local error surface but does NOT roll back
        // the attempt counter — a retry against the same order keeps
        // counting against the budget so a stuck driver lands at
        // escalation rather than looping silently.
        guard state.canBeginScan else { return .none }
        return startSession(state: &state)

      case .sessionStarted(.success(let session)):
        state.lastSession = session
        state.status = .sdkInProgress
        return .run { [identityClient] send in
          let outcome = await identityClient.launchSDK(session)
          await send(.sdkOutcomeReceived(outcome))
        }
        .cancellable(id: CancelID.sdkLaunch, cancelInFlight: true)

      case .sessionStarted(.failure(let box)):
        // Session-start failures are network / configuration issues,
        // NOT verification failures — banner only, no attempt
        // increment. Revert to .notStarted so the driver can tap
        // Begin Scan again.
        state.status = .notStarted
        state.errorBanner = box.userFacingMessage()
        return .none

      case .sdkOutcomeReceived(.canceled):
        // User dismissed the Veriff sheet. NOT a verification attempt.
        state.status = .notStarted
        return .none

      case .sdkOutcomeReceived(.error(let reason)):
        // SDK reported a terminal error before reaching Veriff (e.g.
        // permissions denied, camera failed). Counts as an attempt
        // because a fresh launch would re-walk the same UX.
        state.attempts += 1
        state.status = .failed(reason: reason)
        state.errorBanner = nil
        return .run { [haptics] _ in await haptics.notify(.warning) }

      case .sdkOutcomeReceived(.completed):
        // SDK uploaded the documents. The backend has to fetch the
        // authoritative decision now — we do not trust the SDK
        // callback alone.
        guard let session = state.lastSession else {
          // Shouldn't happen — `.completed` arrives only after a
          // successful sessionStarted that set lastSession. Defensive.
          state.status = .failed(reason: "Lost the Veriff session. Tap Re-Scan to retry.")
          return .none
        }
        state.status = .awaitingResult
        let orderId = state.orderId
        let verificationId = session.verificationId
        return .run { [idScanAPI] send in
          do {
            let route = try await idScanAPI.submitResult(orderId, verificationId)
            await send(.resultSubmitted(.success(route)))
          } catch {
            await send(.resultSubmitted(.failure(IDScanErrorBox(error))))
          }
        }
        .cancellable(id: CancelID.submitResult, cancelInFlight: true)

      case .resultSubmitted(.success(let route)):
        state.route = route
        state.idScan = route.idScan
        if route.idScan.passed {
          state.status = .passed
          state.errorBanner = nil
          return .merge(
            .run { [haptics] _ in await haptics.notify(.success) },
            .send(.delegate(.confirmed(orderId: state.orderId, idScan: route.idScan)))
          )
        }
        // Backend recorded a non-passing decision. Verification
        // attempt counted. The status holds a placeholder reason —
        // the wire shape doesn't carry the failure reason on the
        // order detail (it's logged on `age_verifications`); the iOS
        // UX shows a generic "didn't pass" line with the retry
        // budget remaining as context.
        state.attempts += 1
        state.status = .failed(reason: "Verification didn't pass.")
        return .run { [haptics] _ in await haptics.notify(.warning) }

      case .resultSubmitted(.failure(let box)):
        // Server / network failure — NOT a verification failure. Don't
        // increment attempts; let the driver retry the submit path
        // (which re-launches the SDK against a fresh session, since
        // the old session may be invalidated).
        state.status = .failed(reason: "Couldn't reach Veriff. Tap Re-Scan to retry.")
        state.errorBanner = box.userFacingMessage()
        return .none

      case .errorBannerDismissed:
        state.errorBanner = nil
        return .none

      case .contactSupportTapped:
        return .send(.delegate(.escalatedContactSupport(orderId: state.orderId)))

      case .returnToDispensaryTapped:
        return .send(.delegate(.escalatedReturnToDispensary(orderId: state.orderId)))

      case .backTapped:
        return .merge(
          .cancel(id: CancelID.startSession),
          .cancel(id: CancelID.sdkLaunch),
          .cancel(id: CancelID.submitResult),
          .send(.delegate(.dismissed(orderId: state.orderId)))
        )

      case .delegate:
        return .none
      }
    }
  }

  // MARK: - Effect factories

  private func startSession(state: inout State) -> Effect<Action> {
    state.status = .sessionRequested
    state.errorBanner = nil
    let orderId = state.orderId
    return .run { [idScanAPI] send in
      do {
        let session = try await idScanAPI.startSession(orderId)
        await send(.sessionStarted(.success(session)))
      } catch {
        await send(.sessionStarted(.failure(IDScanErrorBox(error))))
      }
    }
    .cancellable(id: CancelID.startSession, cancelInFlight: true)
  }
}

/// Equatable wrapper around ID-scan errors so the reducer's actions
/// stay `Equatable`. Maps the network surface down to a small set of
/// UX cases — verification-id mismatch (409 ID_SCAN_VERIFICATION_MISMATCH)
/// is a session-state issue that the screen should surface as "Session
/// expired, tap Re-Scan" rather than a generic network banner.
public struct IDScanErrorBox: Error, Equatable, Sendable {
  public enum Kind: Equatable, Sendable {
    case verificationMismatch
    case transport
    case unauthorized
    case malformed(String)
    case server(message: String, code: String?)
    case other(String)
  }

  public let kind: Kind

  public init(_ error: Error) {
    if let driverError = error as? DriverAPIError {
      switch driverError {
      case .malformedPayload(let label): self.kind = .malformed(label)
      case .unimplemented(let name): self.kind = .other(name)
      }
      return
    }
    if let apiError = error as? APIError {
      switch apiError {
      case .server(_, let envelope):
        if envelope.error.code == "ID_SCAN_VERIFICATION_MISMATCH" {
          self.kind = .verificationMismatch
        } else {
          self.kind = .server(message: envelope.error.message, code: envelope.error.code)
        }
      case .transport: self.kind = .transport
      case .unauthorized, .noRefreshToken: self.kind = .unauthorized
      case .unexpectedStatus, .decoding, .configuration:
        self.kind = .other(String(describing: apiError))
      }
      return
    }
    self.kind = .other(String(describing: error))
  }

  public var isVerificationMismatch: Bool {
    if case .verificationMismatch = kind { return true }
    return false
  }

  public func userFacingMessage() -> String {
    switch kind {
    case .verificationMismatch: "Session expired. Tap Re-Scan to start a fresh verification."
    case .transport: "Couldn't reach DankDash. Check your connection."
    case .unauthorized: "Sign in again to continue."
    case .malformed: "Couldn't read the response. Tap Re-Scan to retry."
    case .server(let message, _): message
    case .other(let message): message
    }
  }
}
