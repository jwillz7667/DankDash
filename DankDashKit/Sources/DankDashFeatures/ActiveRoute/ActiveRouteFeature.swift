import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Active-delivery route screen — drives the map + pickup/handoff/
/// dropoff cards + turn-by-turn steps for one in-progress order. A peer
/// to ``DispatchOfferFeature``; the parent (``DriverRootFeature``)
/// presents it after the offer is accepted, hands it the new order's
/// id, and consumes the delegate to push the ID-scan / delivery-
/// complete screens at the right moments.
///
/// Phase machine (local to the reducer, see ``LocalPhase``):
///
///   `.enRouteToPickup`  ─Confirm Pickup (pickup-confirm)→ `.awaitingHandoff`
///   `.awaitingHandoff`  ─vendor handoff (picked_up, observed)→ `.readyToDepart`
///   `.readyToDepart`    ─Start Trip (depart)→ `.enRouteToDropoff`
///   `.enRouteToDropoff` ─Arrived (arrive)→ `.awaitingIdScan` + delegate
///   `.awaitingIdScan`   ─(ID scan + delivery-confirm, parent-driven)→ `.completed`
///
/// The driver chain has a hop the driver does NOT initiate: the vendor
/// physically hands off the bag and marks it in their portal, which
/// fires `DRIVER_PICKED_UP` server-side. The reducer learns about it two
/// ways — a live `order:status_changed` on the shared `/driver` socket
/// and a 15s poll fallback — both funneling through
/// ``Action/serverStatusObserved`` with an advance-only, rank-based
/// reconcile so a server hop never fights the optimistic local UI.
///
/// Deep-linking into an order reseeds the local phase from the server
/// `order.status` (``derivedInitialPhase(from:)``), which is the single
/// authority for where in the leg the driver actually is.
@Reducer
public struct ActiveRouteFeature: Sendable {
  /// Which card / leg the driver is on RIGHT NOW. The `CaseIterable`
  /// declaration order is also the monotonic delivery order — ``rank``
  /// relies on it for advance-only reconciliation, so do not reorder.
  public enum LocalPhase: String, Sendable, Equatable, CaseIterable {
    case enRouteToPickup
    case awaitingHandoff
    case readyToDepart
    case enRouteToDropoff
    case awaitingIdScan
    case completed
  }

  @ObservableState
  public struct State: Equatable, Sendable, Identifiable {
    public var orderId: UUID
    public var route: ActiveRoute?
    public var directions: RouteDirections?
    public var currentStep: RouteStep?
    public var driverLocation: Coordinate?
    public var phase: LocalPhase
    public var isLoadingRoute: Bool
    public var isCalculatingDirections: Bool
    public var confirmPickupInFlight: Bool
    public var departInFlight: Bool
    public var arriveInFlight: Bool
    public var errorBanner: String?

    public var id: UUID { orderId }

    public init(
      orderId: UUID,
      route: ActiveRoute? = nil,
      directions: RouteDirections? = nil,
      currentStep: RouteStep? = nil,
      driverLocation: Coordinate? = nil,
      phase: LocalPhase = .enRouteToPickup,
      isLoadingRoute: Bool = true,
      isCalculatingDirections: Bool = false,
      confirmPickupInFlight: Bool = false,
      departInFlight: Bool = false,
      arriveInFlight: Bool = false,
      errorBanner: String? = nil
    ) {
      self.orderId = orderId
      self.route = route
      self.directions = directions
      self.currentStep = currentStep
      self.driverLocation = driverLocation
      self.phase = phase
      self.isLoadingRoute = isLoadingRoute
      self.isCalculatingDirections = isCalculatingDirections
      self.confirmPickupInFlight = confirmPickupInFlight
      self.departInFlight = departInFlight
      self.arriveInFlight = arriveInFlight
      self.errorBanner = errorBanner
    }

    /// The current navigation target — dispensary while heading to
    /// pickup, dropoff while heading to drop. `nil` while waiting at the
    /// store, while parked ready to depart, and once the scan gate is
    /// reached (no further directions calc).
    public var navigationTarget: Coordinate? {
      guard let route else { return nil }
      switch phase {
      case .enRouteToPickup: return route.dispensary.location
      case .enRouteToDropoff: return route.dropoff.location
      case .awaitingHandoff, .readyToDepart, .awaitingIdScan, .completed: return nil
      }
    }

    public var canConfirmPickup: Bool {
      phase == .enRouteToPickup && !confirmPickupInFlight && route != nil
    }

    public var canDepart: Bool {
      phase == .readyToDepart && !departInFlight && route != nil
    }

    public var canMarkArrived: Bool {
      phase == .enRouteToDropoff && !arriveInFlight && route != nil
    }
  }

  public enum Action: Equatable, Sendable {
    case onAppear
    case onDisappear

    case routeFetched(Result<ActiveRoute, RouteErrorBox>)
    case directionsRequested
    case directionsCalculated(Result<RouteDirections, RouteErrorBox>)
    case locationStreamYielded(Coordinate)

    /// A status change for this order observed on the `/driver` socket or
    /// the poll fallback. Reconciled advance-only against ``State/phase``.
    case serverStatusObserved(OrderStatus)

    case confirmPickupTapped
    case confirmPickupResponse(Result<ActiveRoute, RouteErrorBox>)

    case departTapped
    case departResponse(Result<ActiveRoute, RouteErrorBox>)

    case arrivedTapped
    case arriveResponse(Result<ActiveRoute, RouteErrorBox>)

    case backTapped
    case errorBannerDismissed
    case retryTapped

    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Equatable, Sendable {
      /// Driver reached the customer and the server recorded
      /// `arrived_at_dropoff` — the parent should push the ID scan screen
      /// with these inputs.
      case requestedIdScan(orderId: UUID, idScan: DeliveryHandoff)
      /// Driver backed out of the active route. The parent decides
      /// whether to confirm-dialog or pop straight back to the shift
      /// home.
      case dismissed(orderId: UUID)
    }
  }

  public enum CancelID: Hashable, Sendable {
    case fetchRoute
    case locationStream
    case calculateDirections
    case confirmPickup
    case depart
    case arrive
    case driverEvents
    case handoffPoll
  }

  @Dependency(\.driverOrdersAPIClient) var ordersAPI
  @Dependency(\.driverRealtimeClient) var driverRealtime
  @Dependency(\.directionsClient) var directionsClient
  @Dependency(\.backgroundLocationClient) var locationClient
  @Dependency(\.continuousClock) var clock
  @Dependency(\.date.now) var now

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .onAppear:
        let orderId = state.orderId
        state.isLoadingRoute = (state.route == nil)
        state.errorBanner = nil
        var effects: [Effect<Action>] = [
          fetchRouteEffect(orderId: orderId),
          streamLocationsEffect(),
          subscribeDriverEventsEffect(orderId: orderId)
        ]
        // If we re-appear already waiting on the vendor (deep-link /
        // backgrounding), the socket may have missed the handoff event —
        // start the poll fallback immediately.
        if state.phase == .awaitingHandoff {
          effects.append(startHandoffPollEffect(orderId: orderId))
        }
        return .merge(effects)

      case .onDisappear:
        return .merge(
          .cancel(id: CancelID.locationStream),
          .cancel(id: CancelID.calculateDirections),
          .cancel(id: CancelID.fetchRoute),
          .cancel(id: CancelID.confirmPickup),
          .cancel(id: CancelID.depart),
          .cancel(id: CancelID.arrive),
          .cancel(id: CancelID.driverEvents),
          .cancel(id: CancelID.handoffPoll),
          .run { [driverRealtime] _ in await driverRealtime.disconnect() }
        )

      case .routeFetched(.success(let route)):
        state.route = route
        state.isLoadingRoute = false
        let phase = Self.derivedInitialPhase(from: route)
        state.phase = phase
        var effects: [Effect<Action>] = []
        // Deep-linked straight into the handoff wait → start the poll
        // fallback (the socket subscription started in onAppear handles
        // the live path).
        if phase == .awaitingHandoff {
          effects.append(startHandoffPollEffect(orderId: state.orderId))
        }
        if let driverLocation = state.driverLocation, state.directions == nil {
          effects.append(calculateDirectionsEffect(from: driverLocation, route: route, phase: phase))
        }
        return effects.isEmpty ? .none : .merge(effects)

      case .routeFetched(.failure(let box)):
        state.isLoadingRoute = false
        state.errorBanner = box.userFacingMessage()
        return .none

      case .directionsRequested:
        guard let route = state.route, let driverLocation = state.driverLocation else {
          return .none
        }
        return calculateDirectionsEffect(from: driverLocation, route: route, phase: state.phase)

      case .directionsCalculated(.success(let directions)):
        state.isCalculatingDirections = false
        state.directions = directions
        // If locations arrived before directions, the latest fix may
        // already be past step 0 — seed currentStep by walking the
        // heuristic against the known driverLocation rather than
        // defaulting to step 0 only to skip-jump on the next sample.
        if let first = directions.steps.first {
          if let location = state.driverLocation {
            let idx = nextStepIndex(currentIndex: 0, route: directions, location: location)
            state.currentStep = directions.steps.indices.contains(idx) ? directions.steps[idx] : first
          } else {
            state.currentStep = first
          }
        } else {
          state.currentStep = nil
        }
        return .none

      case .directionsCalculated(.failure(let box)):
        state.isCalculatingDirections = false
        state.errorBanner = box.userFacingMessage()
        return .none

      case .locationStreamYielded(let coord):
        let priorLocation = state.driverLocation
        state.driverLocation = coord
        // Advance current step if we have directions to advance against.
        if let directions = state.directions, let step = state.currentStep {
          let nextIdx = nextStepIndex(currentIndex: step.id, route: directions, location: coord)
          if nextIdx != step.id, nextIdx >= 0, nextIdx < directions.steps.count {
            state.currentStep = directions.steps[nextIdx]
          }
        }
        // Fan every fix to the customer's live map via the `/driver`
        // socket. The client + server both throttle to ~1Hz.
        let publishEffect: Effect<Action> = .run { [driverRealtime] _ in
          await driverRealtime.publishLocation(coord)
        }
        // First location fix after the route arrived → request
        // directions. (If directions arrive first, the route-fetched
        // handler kicks them off instead.)
        if priorLocation == nil,
           let route = state.route,
           state.directions == nil,
           !state.isCalculatingDirections {
          return .merge(
            publishEffect,
            calculateDirectionsEffect(from: coord, route: route, phase: state.phase)
          )
        }
        return publishEffect

      case .serverStatusObserved(let status):
        // Advance-only reconcile: map the server status to a local phase
        // and only move FORWARD. A status we've already passed (or a
        // pre-dispatch / cancel status that has no leg) is a no-op so the
        // socket and poll never fight the optimistic UI.
        guard let mapped = Self.phase(forServerStatus: status) else { return .none }
        guard Self.rank(mapped) > Self.rank(state.phase) else { return .none }
        let previous = state.phase
        state.phase = mapped
        var effects: [Effect<Action>] = []
        if previous == .awaitingHandoff {
          // The vendor handoff landed — stop polling for it.
          effects.append(.cancel(id: CancelID.handoffPoll))
        }
        // Server jumped us onto the dropoff leg without a local depart
        // (e.g. depart confirmed on another device, or a lost response):
        // recalc dropoff directions from the latest fix.
        if mapped == .enRouteToDropoff,
           let location = state.driverLocation,
           let route = state.route {
          state.directions = nil
          state.currentStep = nil
          effects.append(calculateDirectionsEffect(from: location, route: route, phase: .enRouteToDropoff))
        }
        return effects.isEmpty ? .none : .merge(effects)

      case .confirmPickupTapped:
        guard state.canConfirmPickup, let route = state.route else { return .none }
        state.confirmPickupInFlight = true
        state.errorBanner = nil
        let orderId = state.orderId
        let location = state.driverLocation
        let capturedAt = now
        return .run { [ordersAPI] send in
          let fix = location.map {
            DriverLocationFixDTO(coordinate: $0, accuracyMeters: nil, capturedAt: capturedAt)
          }
          let body = DriverPickupConfirmRequestDTO(location: fix)
          do {
            let updated = try await ordersAPI.pickupConfirm(orderId, body)
            await send(.confirmPickupResponse(.success(updated)))
          } catch {
            await send(.confirmPickupResponse(.failure(RouteErrorBox(error))))
          }
          _ = route // capture suppress warning
        }
        .cancellable(id: CancelID.confirmPickup, cancelInFlight: true)

      case .confirmPickupResponse(.success(let updatedRoute)):
        state.confirmPickupInFlight = false
        state.route = updatedRoute
        // Pickup-confirm only reaches `en_route_pickup`; the bag isn't in
        // the car until the vendor confirms the handoff. Sit on the
        // handoff card and start the poll fallback (the socket
        // subscription started in onAppear handles the live path). Drop
        // the dispensary-bound directions — no navigation while waiting.
        state.phase = .awaitingHandoff
        state.directions = nil
        state.currentStep = nil
        return startHandoffPollEffect(orderId: state.orderId)

      case .confirmPickupResponse(.failure(let box)):
        state.confirmPickupInFlight = false
        if box.isStateConflict {
          // The server says the order already moved past the pickup
          // step — refetch and reconcile, do not error-banner.
          return fetchRouteEffect(orderId: state.orderId)
        }
        state.errorBanner = box.userFacingMessage()
        return .none

      case .departTapped:
        guard state.canDepart, let route = state.route else { return .none }
        state.departInFlight = true
        state.errorBanner = nil
        let orderId = state.orderId
        let location = state.driverLocation
        let capturedAt = now
        return .merge(
          // The handoff has happened; stop polling for it before we move.
          .cancel(id: CancelID.handoffPoll),
          .run { [ordersAPI] send in
            let fix = location.map {
              DriverLocationFixDTO(coordinate: $0, accuracyMeters: nil, capturedAt: capturedAt)
            }
            let body = DriverDepartRequestDTO(location: fix)
            do {
              let updated = try await ordersAPI.depart(orderId, body)
              await send(.departResponse(.success(updated)))
            } catch {
              await send(.departResponse(.failure(RouteErrorBox(error))))
            }
            _ = route
          }
          .cancellable(id: CancelID.depart, cancelInFlight: true)
        )

      case .departResponse(.success(let updatedRoute)):
        state.departInFlight = false
        state.route = updatedRoute
        state.phase = .enRouteToDropoff
        // Fresh leg → discard the (absent) prior directions and route to
        // the customer from the current fix.
        state.directions = nil
        state.currentStep = nil
        if let location = state.driverLocation {
          return calculateDirectionsEffect(from: location, route: updatedRoute, phase: .enRouteToDropoff)
        }
        return .none

      case .departResponse(.failure(let box)):
        state.departInFlight = false
        if box.isStateConflict {
          // Order already past picked_up — refetch and reconcile.
          return fetchRouteEffect(orderId: state.orderId)
        }
        state.errorBanner = box.userFacingMessage()
        return .none

      case .arrivedTapped:
        guard state.canMarkArrived, let route = state.route else { return .none }
        state.arriveInFlight = true
        state.errorBanner = nil
        let orderId = state.orderId
        let location = state.driverLocation
        let capturedAt = now
        return .run { [ordersAPI] send in
          let fix = location.map {
            DriverLocationFixDTO(coordinate: $0, accuracyMeters: nil, capturedAt: capturedAt)
          }
          let body = DriverArriveRequestDTO(location: fix)
          do {
            let updated = try await ordersAPI.arrive(orderId, body)
            await send(.arriveResponse(.success(updated)))
          } catch {
            await send(.arriveResponse(.failure(RouteErrorBox(error))))
          }
          _ = route
        }
        .cancellable(id: CancelID.arrive, cancelInFlight: true)

      case .arriveResponse(.success(let updatedRoute)):
        // The server is now at `arrived_at_dropoff`; the ID-scan gate is
        // open. Hand off to the parent with the refreshed handoff payload.
        state.arriveInFlight = false
        state.route = updatedRoute
        state.phase = .awaitingIdScan
        return .send(.delegate(.requestedIdScan(orderId: state.orderId, idScan: updatedRoute.idScan)))

      case .arriveResponse(.failure(let box)):
        state.arriveInFlight = false
        if box.isStateConflict {
          // Already arrived (double-tap / another device) — refetch and,
          // if the server is at the scan gate, proceed to ID scan rather
          // than stranding the driver on a card-less map.
          return arriveConflictRecoveryEffect(orderId: state.orderId)
        }
        state.errorBanner = box.userFacingMessage()
        return .none

      case .backTapped:
        return .send(.delegate(.dismissed(orderId: state.orderId)))

      case .errorBannerDismissed:
        state.errorBanner = nil
        return .none

      case .retryTapped:
        let orderId = state.orderId
        state.isLoadingRoute = state.route == nil
        state.errorBanner = nil
        return fetchRouteEffect(orderId: orderId)

      case .delegate:
        return .none
      }
    }
  }

  // MARK: - Effect factories

  private func fetchRouteEffect(orderId: UUID) -> Effect<Action> {
    .run { [ordersAPI] send in
      do {
        let route = try await ordersAPI.getOrder(orderId)
        await send(.routeFetched(.success(route)))
      } catch {
        await send(.routeFetched(.failure(RouteErrorBox(error))))
      }
    }
    .cancellable(id: CancelID.fetchRoute, cancelInFlight: true)
  }

  private func streamLocationsEffect() -> Effect<Action> {
    .run { [locationClient] send in
      for await coord in locationClient.locationUpdates() {
        await send(.locationStreamYielded(coord))
      }
    }
    .cancellable(id: CancelID.locationStream, cancelInFlight: true)
  }

  /// Subscribes to `order:status_changed` on the shared `/driver` socket
  /// and funnels the changes for THIS order into ``serverStatusObserved``.
  /// Other orders' changes (the driver room is shared across a shift) are
  /// dropped here.
  private func subscribeDriverEventsEffect(orderId: UUID) -> Effect<Action> {
    .run { [driverRealtime] send in
      for await change in await driverRealtime.events() {
        guard change.orderId == orderId else { continue }
        await send(.serverStatusObserved(change.status))
      }
    }
    .cancellable(id: CancelID.driverEvents, cancelInFlight: true)
  }

  /// Poll fallback for the vendor handoff while the driver waits at the
  /// store. The socket is the primary path; this covers a dropped socket
  /// or a missed event. Cancelled the moment the handoff is observed.
  private func startHandoffPollEffect(orderId: UUID) -> Effect<Action> {
    .run { [ordersAPI, clock] send in
      for await _ in clock.timer(interval: .seconds(15)) {
        if let route = try? await ordersAPI.getOrder(orderId) {
          await send(.serverStatusObserved(route.order.status))
        }
      }
    }
    .cancellable(id: CancelID.handoffPoll, cancelInFlight: true)
  }

  /// Recovery for a 409 on `arrive`: refetch, and if the server is at the
  /// ID-scan gate, proceed to the scan (reusing the success path so the
  /// delegate fires with the refreshed handoff). Otherwise reconcile the
  /// leg without forcing the scan.
  private func arriveConflictRecoveryEffect(orderId: UUID) -> Effect<Action> {
    .run { [ordersAPI] send in
      do {
        let route = try await ordersAPI.getOrder(orderId)
        if Self.isAtIdScanGate(route.order.status) {
          await send(.arriveResponse(.success(route)))
        } else {
          await send(.routeFetched(.success(route)))
        }
      } catch {
        await send(.routeFetched(.failure(RouteErrorBox(error))))
      }
    }
    .cancellable(id: CancelID.arrive, cancelInFlight: true)
  }

  private func calculateDirectionsEffect(
    from: Coordinate,
    route: ActiveRoute,
    phase: LocalPhase
  ) -> Effect<Action> {
    let target: Coordinate
    switch phase {
    case .enRouteToPickup: target = route.dispensary.location
    case .enRouteToDropoff: target = route.dropoff.location
    case .awaitingHandoff, .readyToDepart, .awaitingIdScan, .completed:
      return .none
    }
    return .run { [directionsClient] send in
      do {
        let directions = try await directionsClient.calculateRoute(from, target, .automobile)
        await send(.directionsCalculated(.success(directions)))
      } catch {
        await send(.directionsCalculated(.failure(RouteErrorBox(error))))
      }
    }
    .cancellable(id: CancelID.calculateDirections, cancelInFlight: true)
  }

  // MARK: - Phase derivation

  /// Maps a server `order.status` to the local delivery phase. Returns
  /// `nil` for statuses with no active-route leg (pre-dispatch, cancel,
  /// failure) — the caller treats those as no-ops.
  static func phase(forServerStatus status: OrderStatus) -> LocalPhase? {
    switch status {
    case .driverAssigned: return .enRouteToPickup
    case .enRoutePickup: return .awaitingHandoff
    case .pickedUp: return .readyToDepart
    case .enRouteDropoff: return .enRouteToDropoff
    case .arrivedAtDropoff, .idScanPending, .idScanPassed: return .awaitingIdScan
    case .delivered: return .completed
    case .placed, .paymentFailed, .accepted, .rejected, .prepping,
         .readyForPickup, .awaitingDriver, .idScanFailed, .returnedToStore,
         .canceled, .disputed:
      return nil
    }
  }

  /// Position of a phase in the monotonic delivery order (its
  /// `CaseIterable` index). Used to keep ``serverStatusObserved``
  /// advance-only.
  static func rank(_ phase: LocalPhase) -> Int {
    LocalPhase.allCases.firstIndex(of: phase) ?? 0
  }

  /// Whether the server status is at the ID-scan gate (arrived through
  /// scan-passed, but not yet delivered). Drives the arrive-409 recovery.
  static func isAtIdScanGate(_ status: OrderStatus) -> Bool {
    switch status {
    case .arrivedAtDropoff, .idScanPending, .idScanPassed: return true
    default: return false
    }
  }

  /// On screen entry, seed the local phase from the authoritative server
  /// `order.status` so a deep-link or relaunch lands on the correct card.
  /// A passed ID scan defensively pins at least the scan gate even if the
  /// status projection lagged the scan result.
  static func derivedInitialPhase(from route: ActiveRoute) -> LocalPhase {
    let byStatus = phase(forServerStatus: route.order.status) ?? .enRouteToPickup
    if route.idScan.passed, rank(byStatus) < rank(.awaitingIdScan) {
      return .awaitingIdScan
    }
    return byStatus
  }
}

/// Equatable wrapper around the active-route error surface. Mirrors
/// ``OfferErrorBox`` — classifies 409 ORDER_STATE_INVALID as a state
/// conflict so the reducer can refetch instead of banner-erroring.
public struct RouteErrorBox: Error, Equatable, Sendable {
  public enum Kind: Equatable, Sendable {
    case stateConflict(code: String?)
    case notFound
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
    if let directions = error as? DirectionsClientError {
      switch directions {
      case .noRouteFound: self.kind = .other("noRouteFound")
      case .mapKitUnavailable: self.kind = .other("mapKitUnavailable")
      }
      return
    }
    if let apiError = error as? APIError {
      switch apiError {
      case .server(let status, let envelope):
        if status == 409 {
          self.kind = .stateConflict(code: envelope.error.code)
        } else if status == 404 {
          self.kind = .notFound
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

  public var isStateConflict: Bool {
    if case .stateConflict = kind { return true }
    return false
  }

  public func userFacingMessage() -> String {
    switch kind {
    case .stateConflict: "Order state changed. Refreshing…"
    case .notFound: "This order is no longer available."
    case .transport: "Couldn't reach DankDash. Check your connection."
    case .unauthorized: "Sign in again to continue."
    case .malformed: "Couldn't read the response. We'll try again."
    case .server(let message, _): message
    case .other(let message): message
    }
  }
}
