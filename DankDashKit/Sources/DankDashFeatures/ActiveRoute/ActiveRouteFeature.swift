import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Active-delivery route screen — drives the map + pickup/dropoff
/// cards + turn-by-turn steps for one in-progress order. A peer to
/// ``DispatchOfferFeature``; the parent (``DriverRootFeature``)
/// presents it after the offer is accepted, hands it the new order's
/// id, and consumes the delegate to push the ID-scan / delivery-
/// complete screens at the right moments.
///
/// Phase machine (local to the reducer, see ``LocalPhase``):
///
///   `.enRouteToPickup` ─Confirm Pickup→ `.enRouteToDropoff`
///   `.enRouteToDropoff` ─Arrived→ delegate(`.requestedIdScan`)
///
/// The local phase is the source of truth for which card (pickup vs
/// dropoff) is on screen — it diverges from the server status because
/// the pickup-confirm POST advances status to `en_route_pickup` while
/// the iOS UX semantically treats Confirm Pickup as "I have the bag,
/// drive to drop." Deep-linking into an order reseeds the local phase
/// from the events array (`order_pickup_confirmed` present → start at
/// dropoff card).
@Reducer
public struct ActiveRouteFeature: Sendable {
  /// Which card / leg the driver is on RIGHT NOW from the UX's
  /// perspective. Distinct from ``ActiveRoute/currentLeg`` (which is
  /// the server-status projection) — see the comment above on why.
  public enum LocalPhase: String, Sendable, Equatable, CaseIterable {
    case enRouteToPickup
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
      self.errorBanner = errorBanner
    }

    /// The current navigation target — dispensary while heading to
    /// pickup, dropoff while heading to drop. `nil` once handoff
    /// starts (the map stays on the dropoff but there's no further
    /// directions calc).
    public var navigationTarget: Coordinate? {
      guard let route else { return nil }
      switch phase {
      case .enRouteToPickup: return route.dispensary.location
      case .enRouteToDropoff: return route.dropoff.location
      case .awaitingIdScan, .completed: return nil
      }
    }

    public var canConfirmPickup: Bool {
      phase == .enRouteToPickup && !confirmPickupInFlight && route != nil
    }

    public var canMarkArrived: Bool {
      phase == .enRouteToDropoff && route != nil
    }
  }

  public enum Action: Equatable, Sendable {
    case onAppear
    case onDisappear

    case routeFetched(Result<ActiveRoute, RouteErrorBox>)
    case directionsRequested
    case directionsCalculated(Result<RouteDirections, RouteErrorBox>)
    case locationStreamYielded(Coordinate)

    case confirmPickupTapped
    case confirmPickupResponse(Result<ActiveRoute, RouteErrorBox>)

    case arrivedTapped
    case backTapped
    case errorBannerDismissed
    case retryTapped

    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Equatable, Sendable {
      /// Driver tapped Arrived on the dropoff card — the parent should
      /// push the ID scan screen with these inputs.
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
  }

  @Dependency(\.driverOrdersAPIClient) var ordersAPI
  @Dependency(\.directionsClient) var directionsClient
  @Dependency(\.backgroundLocationClient) var locationClient
  @Dependency(\.date.now) var now

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .onAppear:
        let orderId = state.orderId
        state.isLoadingRoute = (state.route == nil)
        state.errorBanner = nil
        return .merge(
          fetchRouteEffect(orderId: orderId),
          streamLocationsEffect()
        )

      case .onDisappear:
        return .merge(
          .cancel(id: CancelID.locationStream),
          .cancel(id: CancelID.calculateDirections),
          .cancel(id: CancelID.fetchRoute),
          .cancel(id: CancelID.confirmPickup)
        )

      case .routeFetched(.success(let route)):
        state.route = route
        state.isLoadingRoute = false
        state.phase = Self.derivedInitialPhase(from: route)
        // If the order already reached a terminal state on the server
        // (delivered / canceled / etc.) the UI should pop straight to
        // the parent — but for Phase 20 we still render the dropoff
        // card briefly and let the parent decide.
        if let driverLocation = state.driverLocation, state.directions == nil {
          return calculateDirectionsEffect(from: driverLocation, route: route, phase: state.phase)
        }
        return .none

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
        // First location fix after the route arrived → request
        // directions. (If directions arrive first, the route-fetched
        // handler kicks them off instead.)
        if priorLocation == nil,
           let route = state.route,
           state.directions == nil,
           !state.isCalculatingDirections {
          return calculateDirectionsEffect(from: coord, route: route, phase: state.phase)
        }
        return .none

      case .confirmPickupTapped:
        guard state.canConfirmPickup, let route = state.route else { return .none }
        state.confirmPickupInFlight = true
        state.errorBanner = nil
        let orderId = state.orderId
        let location = state.driverLocation
        let capturedAt = now
        return .run { [ordersAPI] send in
          let fix = location.map {
            DriverLocationFixDTO(
              coordinate: $0,
              accuracyMeters: nil,
              capturedAt: capturedAt
            )
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
        state.phase = .enRouteToDropoff
        // The leg flipped — the previous dispensary-bound directions
        // are stale. Discard them and request a fresh dropoff route
        // from the current location (if we have one).
        state.directions = nil
        state.currentStep = nil
        if let location = state.driverLocation {
          return calculateDirectionsEffect(from: location, route: updatedRoute, phase: .enRouteToDropoff)
        }
        return .none

      case .confirmPickupResponse(.failure(let box)):
        state.confirmPickupInFlight = false
        if box.isStateConflict {
          // The server says the order already moved past the pickup
          // step — refetch and reconcile, do not error-banner.
          let orderId = state.orderId
          return fetchRouteEffect(orderId: orderId)
        }
        state.errorBanner = box.userFacingMessage()
        return .none

      case .arrivedTapped:
        guard state.canMarkArrived, let route = state.route else { return .none }
        state.phase = .awaitingIdScan
        return .send(.delegate(.requestedIdScan(orderId: state.orderId, idScan: route.idScan)))

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

  private func calculateDirectionsEffect(
    from: Coordinate,
    route: ActiveRoute,
    phase: LocalPhase
  ) -> Effect<Action> {
    let target: Coordinate
    switch phase {
    case .enRouteToPickup: target = route.dispensary.location
    case .enRouteToDropoff: target = route.dropoff.location
    case .awaitingIdScan, .completed:
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

  /// On screen entry, seed the local phase from the events ledger so a
  /// deep-link into an already-pickup-confirmed order lands on the
  /// dropoff card. The `idScan.passed` branch covers re-launch after
  /// ID scan completed but before delivery-confirm fired (rare; the
  /// parent should ordinarily push DeliveryComplete in that case, but
  /// this is the defensive fallback).
  static func derivedInitialPhase(from route: ActiveRoute) -> LocalPhase {
    if route.order.status == .delivered { return .completed }
    if route.idScan.passed { return .awaitingIdScan }
    let hasConfirmedPickup = route.events.contains { $0.eventType == "order_pickup_confirmed" }
    return hasConfirmedPickup ? .enRouteToDropoff : .enRouteToPickup
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
