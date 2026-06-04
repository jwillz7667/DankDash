import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Delivery confirmation screen — fires the
/// `POST /v1/driver/orders/:id/delivery-confirm` request that
/// transitions the order to `delivered` and unlocks the earnings
/// settlement.
///
/// The reducer is intentionally narrow: the parent
/// (``DriverRootFeature``) pushes this screen only AFTER
/// ``IDScanFeature`` emitted `.confirmed`, so when we arrive here the
/// ID-scan gate is already passed in the canonical state. `onAppear`
/// auto-fires the confirm request — there is no separate "Mark
/// Delivered" CTA because the previous screen's CTA already meant
/// "I have handed the package to a verified recipient."
///
/// Defensive case: the backend re-checks the gate inside
/// `OrdersRepository.transitionStatus` and answers with 409
/// `ID_SCAN_REQUIRED` if (somehow) the scan field reads false at
/// transition time. The reducer maps that to ``Delegate/requiresIdScan``
/// so the parent can pop back to the ID-scan screen rather than
/// stranding the driver on a non-actionable error banner.
@Reducer
public struct DeliveryCompleteFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable, Identifiable {
    public var orderId: UUID
    public var route: ActiveRoute
    public var notes: String?
    public var capturedLocation: Coordinate?
    public var status: Status
    public var errorBanner: String?

    public var id: UUID { orderId }

    public init(
      orderId: UUID,
      route: ActiveRoute,
      notes: String? = nil,
      capturedLocation: Coordinate? = nil,
      status: Status = .idle,
      errorBanner: String? = nil
    ) {
      self.orderId = orderId
      self.route = route
      self.notes = notes
      self.capturedLocation = capturedLocation
      self.status = status
      self.errorBanner = errorBanner
    }

    /// `true` while the confirm POST is in flight. The screen disables
    /// Done/Back during this window so a double-tap doesn't fire two
    /// transitions back-to-back.
    public var isConfirming: Bool {
      status == .confirming
    }

    /// `true` once the order has reached `delivered` on the server. The
    /// view renders the success state (checkmark + customer summary +
    /// "Back to Shift").
    public var isDelivered: Bool {
      if case .completed = status { return true }
      return false
    }
  }

  public enum Status: Equatable, Sendable {
    /// Fresh state — onAppear will fire the confirm.
    case idle
    /// Confirm POST in flight.
    case confirming
    /// Server transitioned the order to `delivered`. The route has the
    /// final state attached.
    case completed
    /// Confirm failed in a non-recoverable way (e.g. server 500). The
    /// driver can Retry. State conflicts and ID-scan-required failures
    /// fire delegates instead of landing here.
    case failed
  }

  public enum Action: Equatable, Sendable {
    case onAppear
    case retryTapped
    case doneTapped
    case backTapped

    case confirmResponse(Result<ActiveRoute, RouteErrorBox>)
    case errorBannerDismissed

    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Equatable, Sendable {
      /// Order is now `delivered`. The parent should pop to the shift
      /// home and let the earnings ledger refresh.
      case completed(orderId: UUID, route: ActiveRoute)
      /// Driver tapped Back before confirmation went through, OR the
      /// success state's "Back to Shift" CTA. In either case the parent
      /// pops to the shift root. `wasCompleted` lets the parent decide
      /// whether to refresh the earnings card.
      case dismissed(orderId: UUID, wasCompleted: Bool)
      /// Defensive — backend says the ID-scan gate is not satisfied.
      /// The parent should pop this screen and re-present
      /// ``IDScanFeature`` so the driver can re-verify.
      case requiresIdScan(orderId: UUID)
    }
  }

  public enum CancelID: Hashable, Sendable {
    case confirm
  }

  @Dependency(\.driverOrdersAPIClient) var ordersAPI
  @Dependency(\.hapticsClient) var haptics
  @Dependency(\.date.now) var now

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .onAppear:
        // Idempotent: if the user backgrounded and returned post-
        // completion, do nothing rather than re-fire the transition.
        guard state.status == .idle else { return .none }
        return confirmDeliveryEffect(state: &state)

      case .retryTapped:
        // Only valid after a non-state-conflict failure landed in
        // `.failed`. Re-enters the same confirm chain.
        guard state.status == .failed else { return .none }
        state.errorBanner = nil
        return confirmDeliveryEffect(state: &state)

      case .confirmResponse(.success(let updated)):
        state.status = .completed
        state.route = updated
        state.errorBanner = nil
        return .merge(
          .run { [haptics] _ in await haptics.notify(.success) },
          .send(.delegate(.completed(orderId: state.orderId, route: updated)))
        )

      case .confirmResponse(.failure(let box)):
        if box.isIdScanRequired {
          // The gate fired server-side. Surface a short-lived banner so
          // the driver sees WHY the parent is bouncing them back, and
          // delegate to the parent.
          state.status = .failed
          state.errorBanner = "ID scan required before delivery can be marked complete."
          return .send(.delegate(.requiresIdScan(orderId: state.orderId)))
        }
        if box.isStateConflict {
          // The order moved past `delivered` (already delivered, or
          // canceled by ops). Treat as a soft success — pop back to
          // shift so the driver doesn't get stuck.
          state.status = .completed
          state.errorBanner = nil
          return .send(.delegate(.dismissed(orderId: state.orderId, wasCompleted: true)))
        }
        state.status = .failed
        state.errorBanner = box.userFacingMessage()
        return .run { [haptics] _ in await haptics.notify(.error) }

      case .doneTapped:
        return .send(.delegate(.dismissed(orderId: state.orderId, wasCompleted: state.isDelivered)))

      case .backTapped:
        return .merge(
          .cancel(id: CancelID.confirm),
          .send(.delegate(.dismissed(orderId: state.orderId, wasCompleted: state.isDelivered)))
        )

      case .errorBannerDismissed:
        state.errorBanner = nil
        return .none

      case .delegate:
        return .none
      }
    }
  }

  // MARK: - Effect factories

  private func confirmDeliveryEffect(state: inout State) -> Effect<Action> {
    state.status = .confirming
    state.errorBanner = nil
    let orderId = state.orderId
    let location = state.capturedLocation
    let notes = state.notes
    let capturedAt = now
    return .run { [ordersAPI] send in
      let fix = location.map {
        DriverLocationFixDTO(
          coordinate: $0,
          accuracyMeters: nil,
          capturedAt: capturedAt
        )
      }
      let body = DriverDeliveryConfirmRequestDTO(location: fix, notes: notes)
      do {
        let updated = try await ordersAPI.deliveryConfirm(orderId, body)
        await send(.confirmResponse(.success(updated)))
      } catch {
        await send(.confirmResponse(.failure(RouteErrorBox(error))))
      }
    }
    .cancellable(id: CancelID.confirm, cancelInFlight: true)
  }
}

private extension RouteErrorBox {
  /// `true` when the failure is the backend's compliance-gate response —
  /// 409 with envelope code `ID_SCAN_REQUIRED`. Used by
  /// ``DeliveryCompleteFeature`` to route the driver back to the ID-scan
  /// screen instead of banner-erroring.
  var isIdScanRequired: Bool {
    if case .stateConflict(let code) = kind, code == "ID_SCAN_REQUIRED" {
      return true
    }
    return false
  }
}
