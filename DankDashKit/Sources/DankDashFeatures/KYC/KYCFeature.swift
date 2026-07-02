import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Sheet-mounted reducer for the consumer Persona KYC flow. Minnesota
/// requires a one-time identity check before a cannabis order can be
/// placed (Minn. Stat. §342.27) — the server enforces it as the `kyc`
/// rule inside the checkout compliance evaluation, so an unverified user
/// cannot check out. This reducer is the UX that resolves that block:
/// it explains why, mints a Persona inquiry, opens the hosted flow in
/// Safari, and then reconciles the outcome by reading `kycVerified` off
/// `GET /v1/me` (the Persona webhook is authoritative server-side).
///
/// State machine:
///
/// ```
/// intro ──beginTapped──▶ starting ──startResponse──┬──▶ readyToOpen
///                            ▲                      └──▶ failed
///          retry/restart ────┘
///   readyToOpen ──safariOpened──▶ awaitingReturn
///   awaitingReturn ──safariDismissed──▶ verifying ──poll──┬──▶ approved (emits delegate)
///                                                          └──▶ pendingReview
///   pendingReview ──checkAgain──▶ verifying
///   pendingReview ──restart──▶ starting (mints a fresh inquiry)
/// ```
///
/// The reducer never opens the Persona URL itself — the app-target view
/// owns `SFSafariViewController` and reports `.safariOpened` /
/// `.safariDismissed` as lifecycle events, keeping `SafariServices` out
/// of `DankDashFeatures` (same split as ``CheckoutHandoffFeature``).
///
/// **Webhook lag:** Persona's `inquiry.completed` webhook may land a
/// beat after the user finishes the hosted flow. The `verifying` phase
/// polls `/v1/me` a bounded number of times before falling back to
/// `pendingReview` ("we're still confirming — check again in a moment"),
/// so a slow webhook reads as "pending", never as "failed".
@Reducer
public struct KYCFeature: Sendable {
  /// Number of `/v1/me` polls before the flow settles into
  /// `pendingReview`. At ``pollInterval`` apart this gives the Persona
  /// webhook ~10s to land, which comfortably covers the common case
  /// without leaving the user staring at a spinner.
  static let maxPollAttempts = 6
  static let pollInterval: Duration = .seconds(2)

  @ObservableState
  public struct State: Equatable, Sendable {
    public var phase: Phase

    public init(phase: Phase = .intro) {
      self.phase = phase
    }

    /// The inquiry whose hosted URL the view should present in Safari.
    /// Non-nil only in the "have an inquiry, not yet reconciled" window
    /// so the view presents Safari exactly once per attempt.
    public var presentableInquiry: KYCInquiry? {
      switch phase {
      case .readyToOpen(let inquiry), .awaitingReturn(let inquiry):
        return inquiry
      default:
        return nil
      }
    }

    /// `true` while the view should show a spinner (minting an inquiry
    /// or reconciling `/me`).
    public var isBusy: Bool {
      switch phase {
      case .starting, .verifying:
        return true
      default:
        return false
      }
    }

    /// User-facing failure copy for the error state. `nil` outside
    /// `.failed`.
    public var failureMessage: String? {
      guard case .failed(let reason) = phase else { return nil }
      return reason.message
    }
  }

  public enum Phase: Equatable, Sendable {
    case intro
    case starting
    case readyToOpen(KYCInquiry)
    case awaitingReturn(KYCInquiry)
    /// Polling `/v1/me` for the webhook-driven `kycVerified` flip.
    case verifying
    /// Polled out without a flip — the webhook is likely still in
    /// flight, or the user abandoned the hosted flow. Recoverable via
    /// `checkAgainTapped` (re-poll) or `restartTapped` (new inquiry).
    case pendingReview
    case approved
    case failed(FailureReason)
  }

  /// Recoverable failure shapes. Only inquiry creation can hard-fail
  /// (a `/me` poll failure is treated as "not yet verified" and folds
  /// into `pendingReview`, since it is transient and re-checkable).
  public enum FailureReason: Equatable, Sendable {
    case startFailed(String)

    public var message: String {
      switch self {
      case .startFailed(let copy):
        return copy
      }
    }
  }

  public enum Action: Sendable {
    case beginTapped
    case startResponse(Result<KYCInquiry, EquatableError>)

    /// View lifecycle: `SFSafariViewController` was presented with the
    /// inquiry URL.
    case safariOpened

    /// View lifecycle: the user dismissed Safari (either "Done" or a
    /// programmatic close). We can't know from the client whether they
    /// finished — the server does — so we begin polling `/me`.
    case safariDismissed

    case pollTick(attempt: Int)
    /// `Bool` payload is `kycVerified` from the refreshed `/me`.
    case pollResponse(Result<Bool, EquatableError>, attempt: Int)

    /// From `pendingReview`: re-poll `/me` once.
    case checkAgainTapped
    /// From `pendingReview`/`failed`: mint a brand-new inquiry.
    case restartTapped
    /// From `failed`: retry inquiry creation.
    case retryTapped
    case dismissTapped

    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Sendable, Equatable {
      /// KYC is verified server-side. The parent dismisses this sheet
      /// and re-runs the cart compliance check so checkout unblocks.
      case verified
      case dismissed
    }
  }

  private enum CancelID: Hashable {
    case start
    case poll
  }

  @Dependency(\.kycAPIClient) var kycAPIClient
  @Dependency(\.meAPIClient) var meAPIClient
  @Dependency(\.continuousClock) var clock

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .beginTapped, .retryTapped, .restartTapped:
        return beginInquiry(state: &state)

      case .startResponse(.success(let inquiry)):
        state.phase = .readyToOpen(inquiry)
        return .none

      case .startResponse(.failure(let err)):
        state.phase = .failed(.startFailed(err.message))
        return .none

      case .safariOpened:
        guard case .readyToOpen(let inquiry) = state.phase else { return .none }
        state.phase = .awaitingReturn(inquiry)
        return .none

      case .safariDismissed:
        // Only meaningful once the flow is actually open. If we already
        // reconciled (approved) the dismissal is just cleanup.
        guard case .awaitingReturn = state.phase else { return .none }
        state.phase = .verifying
        return .send(.pollTick(attempt: 1))

      case .pollTick(let attempt):
        return .run { send in
          do {
            let user = try await meAPIClient.getProfile()
            await send(.pollResponse(.success(user.kycVerified), attempt: attempt))
          } catch {
            await send(.pollResponse(.failure(EquatableError(error)), attempt: attempt))
          }
        }
        .cancellable(id: CancelID.poll, cancelInFlight: true)

      case .pollResponse(.success(true), _):
        state.phase = .approved
        return .send(.delegate(.verified))

      case .pollResponse(.success(false), let attempt),
           .pollResponse(.failure, let attempt):
        // Not yet verified (or a transient `/me` failure). Reschedule
        // until we exhaust the budget, then settle into pendingReview.
        return advancePoll(state: &state, attempt: attempt)

      case .checkAgainTapped:
        state.phase = .verifying
        // A single re-poll: seed at `maxPollAttempts` so a non-verified
        // response settles straight back to pendingReview without
        // spinning the whole auto-poll budget again.
        return .send(.pollTick(attempt: Self.maxPollAttempts))

      case .dismissTapped:
        return .merge(
          .cancel(id: CancelID.start),
          .cancel(id: CancelID.poll),
          .send(.delegate(.dismissed))
        )

      case .delegate:
        return .none
      }
    }
  }

  private func beginInquiry(state: inout State) -> Effect<Action> {
    // Idempotent: a double-tap while an inquiry is already in flight
    // must not mint two.
    guard state.phase != .starting else { return .none }
    state.phase = .starting
    return .run { [kycAPIClient] send in
      do {
        let inquiry = try await kycAPIClient.startInquiry()
        await send(.startResponse(.success(inquiry)))
      } catch {
        await send(.startResponse(.failure(EquatableError(error))))
      }
    }
    .cancellable(id: CancelID.start, cancelInFlight: true)
  }

  private func advancePoll(state: inout State, attempt: Int) -> Effect<Action> {
    guard attempt < Self.maxPollAttempts else {
      state.phase = .pendingReview
      return .none
    }
    return .run { [clock] send in
      try await clock.sleep(for: Self.pollInterval)
      await send(.pollTick(attempt: attempt + 1))
    }
    .cancellable(id: CancelID.poll, cancelInFlight: true)
  }
}
