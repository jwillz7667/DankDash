import XCTest
import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

/// Reducer coverage for the driver active-route screen.
///
/// The reducer fans out FOUR concurrent effects on `.onAppear`: a route
/// fetch, a location-stream subscription, a `/driver` socket
/// status-change subscription, and (when both route + a fix arrive) a
/// directions calc — plus a 15s handoff poll while it sits on the
/// handoff-wait card. We use `exhaustivity = .off` for the merge
/// orderings and assert end-state explicitly. The
/// `BackgroundLocationClient.test` factory replays a fixed coordinate
/// list then closes the stream, so each test deterministically controls
/// how many GPS samples land. `continuousClock` is a `TestClock` that is
/// never advanced, so the handoff poll suspends quietly and is torn down
/// with `.onDisappear`.
@MainActor
final class ActiveRouteFeatureTests: XCTestCase {

  // MARK: - onAppear / fetch

  func test_onAppear_fetchesOrderAndCalculatesRoute() async {
    let orderId = Self.orderId
    let initialRoute = Self.activeRoute()
    let directions = Self.fixedDirections()
    let getOrderCalls = Locker<[UUID]>(value: [])
    let calculateCalls = Locker<[CalculateCall]>(value: [])

    let store = TestStore(
      initialState: ActiveRouteFeature.State(orderId: orderId)
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOrdersAPIClient = Self.ordersClient(
        getOrder: { id in
          await getOrderCalls.append(id)
          return initialRoute
        }
      )
      $0.directionsClient = DirectionsClient(
        calculateRoute: { from, to, transport in
          await calculateCalls.append(CalculateCall(from: from, to: to, transport: transport))
          return directions
        },
        liveSteps: { _, _ in AsyncStream { $0.finish() } }
      )
      $0.backgroundLocationClient = .test(
        status: .authorizedAlways,
        coordinates: [Self.driverStart]
      )
    }
    store.exhaustivity = .off

    await store.send(.onAppear)
    await store.skipReceivedActions()
    await store.finish()

    XCTAssertEqual(store.state.route, initialRoute)
    XCTAssertEqual(store.state.phase, .enRouteToPickup)
    XCTAssertEqual(store.state.directions, directions)
    XCTAssertEqual(store.state.currentStep, directions.steps.first)
    XCTAssertEqual(store.state.driverLocation, Self.driverStart)
    XCTAssertFalse(store.state.isLoadingRoute)
    XCTAssertFalse(store.state.isCalculatingDirections)
    XCTAssertNil(store.state.errorBanner)

    let fetchedIds = await getOrderCalls.value
    XCTAssertEqual(fetchedIds, [orderId])

    let calculated = await calculateCalls.value
    XCTAssertEqual(calculated.count, 1)
    XCTAssertEqual(calculated.first?.from, Self.driverStart)
    XCTAssertEqual(calculated.first?.to, Self.dispensaryLocation)
    XCTAssertEqual(calculated.first?.transport, .automobile)
  }

  func test_onAppear_routeFetchFailsWithTransportError_surfacesBanner() async {
    let orderId = Self.orderId
    let store = TestStore(
      initialState: ActiveRouteFeature.State(orderId: orderId)
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOrdersAPIClient = Self.ordersClient(
        getOrder: { _ in throw APIError.transport(NSError(domain: "URLSession", code: -1009)) }
      )
      $0.backgroundLocationClient = .test(status: .authorizedAlways, coordinates: [])
    }
    store.exhaustivity = .off

    await store.send(.onAppear)
    await store.skipReceivedActions()
    await store.finish()

    XCTAssertFalse(store.state.isLoadingRoute)
    XCTAssertNotNil(store.state.errorBanner)
    XCTAssertNil(store.state.route)
    XCTAssertNil(store.state.directions)
  }

  /// Deep-linking onto the dropoff leg (the driver has already departed):
  /// the server `order.status` is `en_route_dropoff`, so the screen must
  /// reseed onto the dropoff phase and route to the CUSTOMER, not the
  /// dispensary.
  func test_onAppear_deepLinkOnDropoffLeg_routesToCustomer() async {
    let orderId = Self.orderId
    let route = Self.activeRoute(status: .enRouteDropoff, hasPickupEvent: true)
    let directions = Self.fixedDirections()
    let calculateCalls = Locker<[CalculateCall]>(value: [])

    let store = TestStore(
      initialState: ActiveRouteFeature.State(orderId: orderId)
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOrdersAPIClient = Self.ordersClient(getOrder: { _ in route })
      $0.directionsClient = DirectionsClient(
        calculateRoute: { from, to, transport in
          await calculateCalls.append(CalculateCall(from: from, to: to, transport: transport))
          return directions
        },
        liveSteps: { _, _ in AsyncStream { $0.finish() } }
      )
      $0.backgroundLocationClient = .test(
        status: .authorizedAlways,
        coordinates: [Self.driverStart]
      )
    }
    store.exhaustivity = .off

    await store.send(.onAppear)
    await store.skipReceivedActions()
    await store.finish()

    XCTAssertEqual(store.state.phase, .enRouteToDropoff)
    let calculated = await calculateCalls.value
    XCTAssertEqual(calculated.first?.to, Self.dropoffLocation, "dropoff leg should route to the customer, not the dispensary")
  }

  /// Deep-linking onto the handoff-wait leg (`en_route_pickup`): the
  /// screen reseeds onto `.awaitingHandoff` and starts the poll fallback.
  func test_onAppear_deepLinkOnHandoffWait_landsOnAwaitingHandoff() async {
    let orderId = Self.orderId
    let route = Self.activeRoute(status: .enRoutePickup, hasPickupEvent: true)

    let store = TestStore(
      initialState: ActiveRouteFeature.State(orderId: orderId)
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOrdersAPIClient = Self.ordersClient(getOrder: { _ in route })
      $0.backgroundLocationClient = .test(status: .authorizedAlways, coordinates: [])
    }
    store.exhaustivity = .off

    await store.send(.onAppear)
    await store.skipReceivedActions()

    XCTAssertEqual(store.state.phase, .awaitingHandoff)
    XCTAssertNil(store.state.directions)

    // Tear down the handoff poll (TestClock never fires it).
    await store.send(.onDisappear)
    await store.finish()
  }

  // MARK: - Live location stream

  func test_threeCoordinatesYielded_advancesCurrentStep() async {
    let orderId = Self.orderId
    let initialRoute = Self.activeRoute()
    let directions = Self.fixedDirections() // three steps

    let coordinates: [Coordinate] = [
      Self.driverStart,
      Coordinate(latitude: 44.9783, longitude: -93.2630), // closer to step 1 start
      Coordinate(latitude: 44.9820, longitude: -93.2650), // closer to step 2 start
    ]

    let store = TestStore(
      initialState: ActiveRouteFeature.State(orderId: orderId)
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOrdersAPIClient = Self.ordersClient(getOrder: { _ in initialRoute })
      $0.directionsClient = DirectionsClient(
        calculateRoute: { _, _, _ in directions },
        liveSteps: { _, _ in AsyncStream { $0.finish() } }
      )
      $0.backgroundLocationClient = .test(
        status: .authorizedAlways,
        coordinates: coordinates
      )
    }
    store.exhaustivity = .off

    await store.send(.onAppear)
    await store.skipReceivedActions()
    await store.finish()

    // All three locations consumed; current step should have advanced
    // past step 0 since each successive coordinate is closer to the
    // next step's start than the previous one's.
    XCTAssertEqual(store.state.driverLocation, coordinates.last)
    XCTAssertEqual(store.state.currentStep?.id, 2)
  }

  func test_locationsArriveBeforeRoute_directionsKicksOffOnceBothPresent() async {
    let orderId = Self.orderId
    let initialRoute = Self.activeRoute()
    let directions = Self.fixedDirections()
    let calculateCalls = Locker<[CalculateCall]>(value: [])

    let store = TestStore(
      // Seed driverLocation so the on-locationStreamYielded path
      // doesn't fire calculate; the routeFetched handler must do it.
      initialState: ActiveRouteFeature.State(
        orderId: orderId,
        driverLocation: Self.driverStart
      )
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOrdersAPIClient = Self.ordersClient(getOrder: { _ in initialRoute })
      $0.directionsClient = DirectionsClient(
        calculateRoute: { from, to, transport in
          await calculateCalls.append(CalculateCall(from: from, to: to, transport: transport))
          return directions
        },
        liveSteps: { _, _ in AsyncStream { $0.finish() } }
      )
      $0.backgroundLocationClient = .test(status: .authorizedAlways, coordinates: [])
    }
    store.exhaustivity = .off

    await store.send(.onAppear)
    await store.skipReceivedActions()
    await store.finish()

    XCTAssertEqual(store.state.directions, directions)
    let calculated = await calculateCalls.value
    XCTAssertEqual(calculated.count, 1)
    XCTAssertEqual(calculated.first?.from, Self.driverStart)
  }

  /// Every GPS fix is fanned to the customer's live map via the `/driver`
  /// socket publisher — even with no route/directions loaded yet.
  func test_locationStreamYielded_publishesFixToRealtime() async {
    let orderId = Self.orderId
    let publishedCoords = Locker<[Coordinate]>(value: [])

    let store = TestStore(
      initialState: ActiveRouteFeature.State(orderId: orderId, isLoadingRoute: false)
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverRealtimeClient = DriverRealtimeClient(
        publishLocation: { coord in await publishedCoords.append(coord) },
        events: { AsyncStream { $0.finish() } },
        disconnect: { }
      )
    }
    store.exhaustivity = .off

    await store.send(.locationStreamYielded(Self.driverStart))
    await store.finish()

    let coords = await publishedCoords.value
    XCTAssertEqual(coords, [Self.driverStart])
    XCTAssertEqual(store.state.driverLocation, Self.driverStart)
  }

  // MARK: - Confirm Pickup

  /// Pickup-confirm reaches `en_route_pickup` — the bag is NOT in the car
  /// until the vendor confirms the physical handoff. The reducer parks on
  /// the handoff-wait card, drops the dispensary directions, and starts
  /// the poll fallback. No dropoff directions are calculated yet.
  func test_confirmPickup_happyPath_landsOnHandoffWait() async {
    let orderId = Self.orderId
    let initialRoute = Self.activeRoute()
    let pickupResponse = Self.activeRoute(status: .enRoutePickup, hasPickupEvent: true)
    let toPickupDirections = Self.fixedDirections()
    let pickupCalls = Locker<[PickupCall]>(value: [])
    let calculateCalls = Locker<[CalculateCall]>(value: [])

    let store = TestStore(
      initialState: ActiveRouteFeature.State(
        orderId: orderId,
        route: initialRoute,
        directions: toPickupDirections,
        currentStep: toPickupDirections.steps.first,
        driverLocation: Self.driverStart,
        phase: .enRouteToPickup,
        isLoadingRoute: false
      )
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOrdersAPIClient = Self.ordersClient(
        getOrder: { _ in pickupResponse },
        pickupConfirm: { id, body in
          await pickupCalls.append(PickupCall(orderId: id, hasLocation: body.location != nil))
          return pickupResponse
        }
      )
      $0.directionsClient = DirectionsClient(
        calculateRoute: { from, to, transport in
          await calculateCalls.append(CalculateCall(from: from, to: to, transport: transport))
          return Self.fixedDirections()
        },
        liveSteps: { _, _ in AsyncStream { $0.finish() } }
      )
      $0.backgroundLocationClient = .test(status: .authorizedAlways, coordinates: [])
      $0.date = .constant(Self.referenceDate)
    }
    store.exhaustivity = .off

    await store.send(.confirmPickupTapped)
    await store.skipReceivedActions()

    XCTAssertEqual(store.state.phase, .awaitingHandoff)
    XCTAssertEqual(store.state.route, pickupResponse)
    XCTAssertNil(store.state.directions)
    XCTAssertNil(store.state.currentStep)
    XCTAssertFalse(store.state.confirmPickupInFlight)
    XCTAssertNil(store.state.errorBanner)

    let recordedPickup = await pickupCalls.value
    XCTAssertEqual(recordedPickup.count, 1)
    XCTAssertEqual(recordedPickup.first?.orderId, orderId)
    XCTAssertTrue(recordedPickup.first?.hasLocation ?? false)

    // No navigation directions are calculated on pickup-confirm anymore —
    // routing resumes only after the handoff + Start Trip.
    let calculated = await calculateCalls.value
    XCTAssertTrue(calculated.isEmpty, "no directions should be calculated while waiting for handoff")

    await store.send(.onDisappear)
    await store.finish()
  }

  func test_confirmPickup_409StateConflict_refetchesInsteadOfErrorBanner() async {
    let orderId = Self.orderId
    let initialRoute = Self.activeRoute()
    let refetched = Self.activeRoute(status: .enRoutePickup, hasPickupEvent: true)
    let getOrderCalls = Locker<[UUID]>(value: [])

    let store = TestStore(
      initialState: ActiveRouteFeature.State(
        orderId: orderId,
        route: initialRoute,
        driverLocation: Self.driverStart,
        phase: .enRouteToPickup,
        isLoadingRoute: false
      )
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOrdersAPIClient = Self.ordersClient(
        getOrder: { id in
          await getOrderCalls.append(id)
          return refetched
        },
        pickupConfirm: { _, _ in
          throw APIError.server(
            status: 409,
            envelope: Self.envelope(code: "ORDER_STATE_INVALID")
          )
        }
      )
      $0.directionsClient = DirectionsClient(
        calculateRoute: { _, _, _ in Self.fixedDirections() },
        liveSteps: { _, _ in AsyncStream { $0.finish() } }
      )
      $0.backgroundLocationClient = .test(status: .authorizedAlways, coordinates: [])
      $0.date = .constant(Self.referenceDate)
    }
    store.exhaustivity = .off

    await store.send(.confirmPickupTapped)
    await store.skipReceivedActions()

    XCTAssertFalse(store.state.confirmPickupInFlight)
    XCTAssertNil(store.state.errorBanner, "409 ORDER_STATE_INVALID should refetch, not banner")
    XCTAssertEqual(store.state.route, refetched)
    XCTAssertEqual(store.state.phase, .awaitingHandoff)
    let fetchedIds = await getOrderCalls.value
    XCTAssertEqual(fetchedIds, [orderId])

    await store.send(.onDisappear)
    await store.finish()
  }

  func test_confirmPickup_500_setsErrorBannerKeepsPhase() async {
    let orderId = Self.orderId
    let initialRoute = Self.activeRoute()
    let store = TestStore(
      initialState: ActiveRouteFeature.State(
        orderId: orderId,
        route: initialRoute,
        driverLocation: Self.driverStart,
        phase: .enRouteToPickup,
        isLoadingRoute: false
      )
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOrdersAPIClient = Self.ordersClient(
        pickupConfirm: { _, _ in
          throw APIError.server(
            status: 500,
            envelope: Self.envelope(code: "INTERNAL_ERROR", message: "boom")
          )
        }
      )
      $0.backgroundLocationClient = .test(status: .authorizedAlways, coordinates: [])
      $0.date = .constant(Self.referenceDate)
    }
    store.exhaustivity = .off

    await store.send(.confirmPickupTapped)
    await store.skipReceivedActions()
    await store.finish()

    XCTAssertFalse(store.state.confirmPickupInFlight)
    XCTAssertEqual(store.state.errorBanner, "boom")
    XCTAssertEqual(store.state.phase, .enRouteToPickup)
  }

  func test_confirmPickup_whileInFlight_isNoOp() async {
    let orderId = Self.orderId
    let store = TestStore(
      initialState: ActiveRouteFeature.State(
        orderId: orderId,
        route: Self.activeRoute(),
        driverLocation: Self.driverStart,
        phase: .enRouteToPickup,
        isLoadingRoute: false,
        confirmPickupInFlight: true
      )
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.date = .constant(Self.referenceDate)
    }

    await store.send(.confirmPickupTapped)
  }

  func test_confirmPickup_wrongPhase_isNoOp() async {
    let orderId = Self.orderId
    let store = TestStore(
      initialState: ActiveRouteFeature.State(
        orderId: orderId,
        route: Self.activeRoute(),
        driverLocation: Self.driverStart,
        phase: .enRouteToDropoff,
        isLoadingRoute: false
      )
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.date = .constant(Self.referenceDate)
    }

    await store.send(.confirmPickupTapped)
  }

  // MARK: - Server status reconcile (handoff)

  /// The vendor confirms the physical handoff in their portal →
  /// `picked_up` fans out over the `/driver` socket → the reducer
  /// advances off the handoff-wait card to "ready to depart" and stops
  /// polling.
  func test_serverStatusObserved_pickedUp_advancesToReadyToDepart() async {
    let orderId = Self.orderId
    let store = TestStore(
      initialState: ActiveRouteFeature.State(
        orderId: orderId,
        route: Self.activeRoute(status: .enRoutePickup, hasPickupEvent: true),
        phase: .awaitingHandoff,
        isLoadingRoute: false
      )
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.serverStatusObserved(.pickedUp)) {
      $0.phase = .readyToDepart
    }
  }

  /// A status we've already passed (server lag, duplicate poll) never
  /// drags the optimistic UI backwards.
  func test_serverStatusObserved_staleStatus_isNoOp() async {
    let orderId = Self.orderId
    let store = TestStore(
      initialState: ActiveRouteFeature.State(
        orderId: orderId,
        route: Self.activeRoute(status: .enRouteDropoff, hasPickupEvent: true),
        phase: .enRouteToDropoff,
        isLoadingRoute: false
      )
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    // `.enRoutePickup` maps to `.awaitingHandoff` (rank 1) which is behind
    // `.enRouteToDropoff` (rank 3) → ignored.
    await store.send(.serverStatusObserved(.enRoutePickup))
  }

  /// A pre-dispatch / cancel status has no delivery leg and is ignored.
  func test_serverStatusObserved_nonLegStatus_isNoOp() async {
    let orderId = Self.orderId
    let store = TestStore(
      initialState: ActiveRouteFeature.State(
        orderId: orderId,
        route: Self.activeRoute(status: .enRoutePickup, hasPickupEvent: true),
        phase: .awaitingHandoff,
        isLoadingRoute: false
      )
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.serverStatusObserved(.canceled))
  }

  /// Server jumped the order straight onto the dropoff leg (depart
  /// confirmed elsewhere / lost response): the reducer advances and
  /// recalculates directions to the customer.
  func test_serverStatusObserved_jumpToDropoff_recalcsDirections() async {
    let orderId = Self.orderId
    let directions = Self.fixedDirections()
    let calculateCalls = Locker<[CalculateCall]>(value: [])

    let store = TestStore(
      initialState: ActiveRouteFeature.State(
        orderId: orderId,
        route: Self.activeRoute(status: .pickedUp, hasPickupEvent: true),
        driverLocation: Self.dispensaryLocation,
        phase: .readyToDepart,
        isLoadingRoute: false
      )
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.directionsClient = DirectionsClient(
        calculateRoute: { from, to, transport in
          await calculateCalls.append(CalculateCall(from: from, to: to, transport: transport))
          return directions
        },
        liveSteps: { _, _ in AsyncStream { $0.finish() } }
      )
    }
    store.exhaustivity = .off

    await store.send(.serverStatusObserved(.enRouteDropoff))
    await store.skipReceivedActions()
    await store.finish()

    XCTAssertEqual(store.state.phase, .enRouteToDropoff)
    let calculated = await calculateCalls.value
    XCTAssertEqual(calculated.count, 1)
    XCTAssertEqual(calculated.first?.to, Self.dropoffLocation)
  }

  // MARK: - Depart

  /// Start Trip at `picked_up` → POST `depart` → `en_route_dropoff`, and
  /// directions are recalculated to the customer from the current fix.
  func test_departTapped_happyPath_routesToCustomer() async {
    let orderId = Self.orderId
    let pickedUpRoute = Self.activeRoute(status: .pickedUp, hasPickupEvent: true)
    let departedRoute = Self.activeRoute(status: .enRouteDropoff, hasPickupEvent: true)
    let departCalls = Locker<[PickupCall]>(value: [])
    let calculateCalls = Locker<[CalculateCall]>(value: [])

    let store = TestStore(
      initialState: ActiveRouteFeature.State(
        orderId: orderId,
        route: pickedUpRoute,
        driverLocation: Self.dispensaryLocation,
        phase: .readyToDepart,
        isLoadingRoute: false
      )
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOrdersAPIClient = Self.ordersClient(
        depart: { id, body in
          await departCalls.append(PickupCall(orderId: id, hasLocation: body.location != nil))
          return departedRoute
        }
      )
      $0.directionsClient = DirectionsClient(
        calculateRoute: { from, to, transport in
          await calculateCalls.append(CalculateCall(from: from, to: to, transport: transport))
          return Self.fixedDirections()
        },
        liveSteps: { _, _ in AsyncStream { $0.finish() } }
      )
      $0.date = .constant(Self.referenceDate)
    }
    store.exhaustivity = .off

    await store.send(.departTapped)
    await store.skipReceivedActions()
    await store.finish()

    XCTAssertEqual(store.state.phase, .enRouteToDropoff)
    XCTAssertEqual(store.state.route, departedRoute)
    XCTAssertFalse(store.state.departInFlight)
    XCTAssertNil(store.state.errorBanner)

    let recordedDepart = await departCalls.value
    XCTAssertEqual(recordedDepart.count, 1)
    XCTAssertEqual(recordedDepart.first?.orderId, orderId)
    XCTAssertTrue(recordedDepart.first?.hasLocation ?? false)

    let calculated = await calculateCalls.value
    XCTAssertEqual(calculated.count, 1)
    XCTAssertEqual(calculated.first?.from, Self.dispensaryLocation)
    XCTAssertEqual(calculated.first?.to, Self.dropoffLocation)
  }

  func test_departTapped_409StateConflict_refetches() async {
    let orderId = Self.orderId
    let pickedUpRoute = Self.activeRoute(status: .pickedUp, hasPickupEvent: true)
    let refetched = Self.activeRoute(status: .enRouteDropoff, hasPickupEvent: true)
    let getOrderCalls = Locker<[UUID]>(value: [])

    let store = TestStore(
      initialState: ActiveRouteFeature.State(
        orderId: orderId,
        route: pickedUpRoute,
        driverLocation: Self.dispensaryLocation,
        phase: .readyToDepart,
        isLoadingRoute: false
      )
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOrdersAPIClient = Self.ordersClient(
        getOrder: { id in
          await getOrderCalls.append(id)
          return refetched
        },
        depart: { _, _ in
          throw APIError.server(status: 409, envelope: Self.envelope(code: "ORDER_STATE_INVALID"))
        }
      )
      $0.directionsClient = DirectionsClient(
        calculateRoute: { _, _, _ in Self.fixedDirections() },
        liveSteps: { _, _ in AsyncStream { $0.finish() } }
      )
      $0.date = .constant(Self.referenceDate)
    }
    store.exhaustivity = .off

    await store.send(.departTapped)
    await store.skipReceivedActions()
    await store.finish()

    XCTAssertFalse(store.state.departInFlight)
    XCTAssertNil(store.state.errorBanner, "409 should refetch, not banner")
    XCTAssertEqual(store.state.route, refetched)
    XCTAssertEqual(store.state.phase, .enRouteToDropoff)
    let fetchedIds = await getOrderCalls.value
    XCTAssertEqual(fetchedIds, [orderId])
  }

  func test_departTapped_wrongPhase_isNoOp() async {
    let orderId = Self.orderId
    let store = TestStore(
      initialState: ActiveRouteFeature.State(
        orderId: orderId,
        route: Self.activeRoute(),
        driverLocation: Self.driverStart,
        phase: .enRouteToPickup,
        isLoadingRoute: false
      )
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.date = .constant(Self.referenceDate)
    }

    await store.send(.departTapped)
  }

  // MARK: - Arrived

  /// Tapping Arrived at `en_route_dropoff` POSTs `arrive` FIRST (reaching
  /// `arrived_at_dropoff` server-side), then delegates to the ID scan with
  /// the refreshed handoff payload. Jumping straight to the scan would 409
  /// because the order is still pre-arrival.
  func test_arrivedTapped_atDropoffPhase_postsArriveThenEmitsIdScanDelegate() async {
    let orderId = Self.orderId
    let enRouteDropoff = Self.activeRoute(status: .enRouteDropoff, hasPickupEvent: true)
    let arrivedRoute = Self.activeRoute(status: .arrivedAtDropoff, hasPickupEvent: true)
    let arriveCalls = Locker<[PickupCall]>(value: [])

    let store = TestStore(
      initialState: ActiveRouteFeature.State(
        orderId: orderId,
        route: enRouteDropoff,
        driverLocation: Self.dropoffLocation,
        phase: .enRouteToDropoff,
        isLoadingRoute: false
      )
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOrdersAPIClient = Self.ordersClient(
        arrive: { id, body in
          await arriveCalls.append(PickupCall(orderId: id, hasLocation: body.location != nil))
          return arrivedRoute
        }
      )
      $0.date = .constant(Self.referenceDate)
    }
    store.exhaustivity = .off

    await store.send(.arrivedTapped)
    await store.receive(\.delegate.requestedIdScan)
    await store.finish()

    XCTAssertEqual(store.state.phase, .awaitingIdScan)
    XCTAssertEqual(store.state.route, arrivedRoute)
    XCTAssertFalse(store.state.arriveInFlight)

    let recordedArrive = await arriveCalls.value
    XCTAssertEqual(recordedArrive.count, 1)
    XCTAssertEqual(recordedArrive.first?.orderId, orderId)
    XCTAssertTrue(recordedArrive.first?.hasLocation ?? false)
  }

  /// A 409 on arrive where the server is already at the scan gate
  /// (double-tap / another device) recovers by proceeding to the ID scan
  /// rather than stranding the driver on a card-less map.
  func test_arrivedTapped_409AtScanGate_proceedsToScan() async {
    let orderId = Self.orderId
    let enRouteDropoff = Self.activeRoute(status: .enRouteDropoff, hasPickupEvent: true)
    let alreadyArrived = Self.activeRoute(status: .arrivedAtDropoff, hasPickupEvent: true)

    let store = TestStore(
      initialState: ActiveRouteFeature.State(
        orderId: orderId,
        route: enRouteDropoff,
        driverLocation: Self.dropoffLocation,
        phase: .enRouteToDropoff,
        isLoadingRoute: false
      )
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOrdersAPIClient = Self.ordersClient(
        getOrder: { _ in alreadyArrived },
        arrive: { _, _ in
          throw APIError.server(status: 409, envelope: Self.envelope(code: "ORDER_STATE_INVALID"))
        }
      )
      $0.date = .constant(Self.referenceDate)
    }
    store.exhaustivity = .off

    await store.send(.arrivedTapped)
    await store.receive(\.delegate.requestedIdScan)
    await store.finish()

    XCTAssertEqual(store.state.phase, .awaitingIdScan)
    XCTAssertFalse(store.state.arriveInFlight)
    XCTAssertNil(store.state.errorBanner)
  }

  func test_arrivedTapped_500_setsErrorBannerKeepsPhase() async {
    let orderId = Self.orderId
    let store = TestStore(
      initialState: ActiveRouteFeature.State(
        orderId: orderId,
        route: Self.activeRoute(status: .enRouteDropoff, hasPickupEvent: true),
        driverLocation: Self.dropoffLocation,
        phase: .enRouteToDropoff,
        isLoadingRoute: false
      )
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOrdersAPIClient = Self.ordersClient(
        arrive: { _, _ in
          throw APIError.server(status: 500, envelope: Self.envelope(code: "INTERNAL_ERROR", message: "boom"))
        }
      )
      $0.date = .constant(Self.referenceDate)
    }
    store.exhaustivity = .off

    await store.send(.arrivedTapped)
    await store.skipReceivedActions()
    await store.finish()

    XCTAssertFalse(store.state.arriveInFlight)
    XCTAssertEqual(store.state.errorBanner, "boom")
    XCTAssertEqual(store.state.phase, .enRouteToDropoff)
  }

  func test_arrivedTapped_wrongPhase_isNoOp() async {
    let orderId = Self.orderId
    let store = TestStore(
      initialState: ActiveRouteFeature.State(
        orderId: orderId,
        route: Self.activeRoute(),
        phase: .enRouteToPickup,
        isLoadingRoute: false
      )
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.arrivedTapped)
  }

  // MARK: - Back / dismiss

  func test_backTapped_emitsDismissedDelegate() async {
    let orderId = Self.orderId
    let store = TestStore(
      initialState: ActiveRouteFeature.State(
        orderId: orderId,
        route: Self.activeRoute(),
        isLoadingRoute: false
      )
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.backTapped)
    await store.receive(\.delegate.dismissed)
  }

  // MARK: - Error banner

  func test_errorBannerDismissed_clearsBanner() async {
    let orderId = Self.orderId
    let store = TestStore(
      initialState: ActiveRouteFeature.State(
        orderId: orderId,
        isLoadingRoute: false,
        errorBanner: "oops"
      )
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.errorBannerDismissed) {
      $0.errorBanner = nil
    }
  }

  func test_retryTapped_refetchesAndClearsBanner() async {
    let orderId = Self.orderId
    let route = Self.activeRoute()
    let getOrderCalls = Locker<[UUID]>(value: [])

    let store = TestStore(
      initialState: ActiveRouteFeature.State(
        orderId: orderId,
        isLoadingRoute: false,
        errorBanner: "previous failure"
      )
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOrdersAPIClient = Self.ordersClient(
        getOrder: { id in
          await getOrderCalls.append(id)
          return route
        }
      )
    }
    store.exhaustivity = .off

    await store.send(.retryTapped) {
      $0.errorBanner = nil
      $0.isLoadingRoute = true
    }
    await store.skipReceivedActions()
    await store.finish()

    XCTAssertEqual(store.state.route, route)
    XCTAssertFalse(store.state.isLoadingRoute)
    XCTAssertNil(store.state.errorBanner)
    let fetchedIds = await getOrderCalls.value
    XCTAssertEqual(fetchedIds, [orderId])
  }

  // MARK: - State derivation

  func test_derivedInitialPhase_freshOrder_returnsEnRouteToPickup() {
    let route = Self.activeRoute()
    XCTAssertEqual(ActiveRouteFeature.derivedInitialPhase(from: route), .enRouteToPickup)
  }

  func test_derivedInitialPhase_enRoutePickup_returnsAwaitingHandoff() {
    let route = Self.activeRoute(status: .enRoutePickup, hasPickupEvent: true)
    XCTAssertEqual(ActiveRouteFeature.derivedInitialPhase(from: route), .awaitingHandoff)
  }

  func test_derivedInitialPhase_pickedUp_returnsReadyToDepart() {
    let route = Self.activeRoute(status: .pickedUp, hasPickupEvent: true)
    XCTAssertEqual(ActiveRouteFeature.derivedInitialPhase(from: route), .readyToDepart)
  }

  func test_derivedInitialPhase_enRouteDropoff_returnsEnRouteToDropoff() {
    let route = Self.activeRoute(status: .enRouteDropoff, hasPickupEvent: true)
    XCTAssertEqual(ActiveRouteFeature.derivedInitialPhase(from: route), .enRouteToDropoff)
  }

  func test_derivedInitialPhase_idScanPassed_returnsAwaitingIdScan() {
    let route = Self.activeRoute(
      status: .idScanPassed,
      hasPickupEvent: true,
      idScanPassed: true
    )
    XCTAssertEqual(ActiveRouteFeature.derivedInitialPhase(from: route), .awaitingIdScan)
  }

  /// Defensive pin: a passed ID scan whose status projection lagged still
  /// lands at least on the scan gate, never back on a navigation leg.
  func test_derivedInitialPhase_idScanPassedButStatusLagged_pinsScanGate() {
    let route = Self.activeRoute(
      status: .enRouteDropoff,
      hasPickupEvent: true,
      idScanPassed: true
    )
    XCTAssertEqual(ActiveRouteFeature.derivedInitialPhase(from: route), .awaitingIdScan)
  }

  func test_derivedInitialPhase_delivered_returnsCompleted() {
    let route = Self.activeRoute(status: .delivered, hasPickupEvent: true)
    XCTAssertEqual(ActiveRouteFeature.derivedInitialPhase(from: route), .completed)
  }

  // MARK: - State helpers

  func test_navigationTarget_isDispensaryWhenEnRouteToPickup() {
    let state = ActiveRouteFeature.State(
      orderId: Self.orderId,
      route: Self.activeRoute(),
      phase: .enRouteToPickup
    )
    XCTAssertEqual(state.navigationTarget, Self.dispensaryLocation)
  }

  func test_navigationTarget_isDropoffWhenEnRouteToDropoff() {
    let state = ActiveRouteFeature.State(
      orderId: Self.orderId,
      route: Self.activeRoute(),
      phase: .enRouteToDropoff
    )
    XCTAssertEqual(state.navigationTarget, Self.dropoffLocation)
  }

  func test_navigationTarget_isNilWhenAwaitingHandoff() {
    let state = ActiveRouteFeature.State(
      orderId: Self.orderId,
      route: Self.activeRoute(),
      phase: .awaitingHandoff
    )
    XCTAssertNil(state.navigationTarget)
  }

  func test_navigationTarget_isNilWhenReadyToDepart() {
    let state = ActiveRouteFeature.State(
      orderId: Self.orderId,
      route: Self.activeRoute(),
      phase: .readyToDepart
    )
    XCTAssertNil(state.navigationTarget)
  }

  func test_navigationTarget_isNilWhenAwaitingIdScan() {
    let state = ActiveRouteFeature.State(
      orderId: Self.orderId,
      route: Self.activeRoute(),
      phase: .awaitingIdScan
    )
    XCTAssertNil(state.navigationTarget)
  }

  func test_canConfirmPickup_falseWhenAlreadyOnDropoffPhase() {
    let state = ActiveRouteFeature.State(
      orderId: Self.orderId,
      route: Self.activeRoute(),
      phase: .enRouteToDropoff
    )
    XCTAssertFalse(state.canConfirmPickup)
  }

  func test_canDepart_trueWhenReadyToDepartWithRoute() {
    let state = ActiveRouteFeature.State(
      orderId: Self.orderId,
      route: Self.activeRoute(status: .pickedUp, hasPickupEvent: true),
      phase: .readyToDepart
    )
    XCTAssertTrue(state.canDepart)
  }

  func test_canDepart_falseWhileDepartInFlight() {
    let state = ActiveRouteFeature.State(
      orderId: Self.orderId,
      route: Self.activeRoute(status: .pickedUp, hasPickupEvent: true),
      phase: .readyToDepart,
      departInFlight: true
    )
    XCTAssertFalse(state.canDepart)
  }

  func test_canMarkArrived_falseWhileArriveInFlight() {
    let state = ActiveRouteFeature.State(
      orderId: Self.orderId,
      route: Self.activeRoute(status: .enRouteDropoff, hasPickupEvent: true),
      phase: .enRouteToDropoff,
      arriveInFlight: true
    )
    XCTAssertFalse(state.canMarkArrived)
  }

  // MARK: - Step heuristic

  func test_nextStepIndex_advancesWhenCloserToNextStart() {
    let directions = Self.fixedDirections()
    // The middle coordinate sits between step 1 and 2; the heuristic
    // should advance from 0 → 1.
    let coord = Coordinate(latitude: 44.9782, longitude: -93.2628)
    let advanced = nextStepIndex(currentIndex: 0, route: directions, location: coord)
    XCTAssertGreaterThan(advanced, 0)
  }

  func test_nextStepIndex_pegsAtLastStep() {
    let directions = Self.fixedDirections()
    let lastIdx = directions.steps.count - 1
    let advanced = nextStepIndex(currentIndex: lastIdx, route: directions, location: Self.driverStart)
    XCTAssertEqual(advanced, lastIdx)
  }

  func test_haversineMeters_knownDistance() {
    // Roughly 0.11 miles → ~177m
    let a = Coordinate(latitude: 44.9778, longitude: -93.2650)
    let b = Coordinate(latitude: 44.9794, longitude: -93.2650)
    let meters = haversineMeters(a, b)
    XCTAssertEqual(meters, 178.0, accuracy: 5.0)
  }

  // MARK: - RouteErrorBox

  func test_routeErrorBox_classifies409_asStateConflict() {
    let error = APIError.server(
      status: 409,
      envelope: Self.envelope(code: "ORDER_STATE_INVALID")
    )
    XCTAssertTrue(RouteErrorBox(error).isStateConflict)
  }

  func test_routeErrorBox_classifies404_asNotFound() {
    let error = APIError.server(
      status: 404,
      envelope: Self.envelope(code: "ORDER_NOT_FOUND")
    )
    if case .notFound = RouteErrorBox(error).kind {
      // expected
    } else {
      XCTFail("expected .notFound")
    }
  }

  func test_routeErrorBox_classifiesDirectionsNoRoute() {
    let box = RouteErrorBox(DirectionsClientError.noRouteFound)
    if case .other(let label) = box.kind {
      XCTAssertEqual(label, "noRouteFound")
    } else {
      XCTFail("expected .other(noRouteFound)")
    }
  }

  // MARK: - Fixtures

  nonisolated private static let orderId =
    UUID(uuidString: "00000000-0000-0000-0000-0000000000ee")!

  nonisolated private static let driverId =
    UUID(uuidString: "00000000-0000-0000-0000-0000000000dd")!

  nonisolated private static let dispensaryId =
    UUID(uuidString: "00000000-0000-0000-0000-0000000000cc")!

  nonisolated private static let userId =
    UUID(uuidString: "00000000-0000-0000-0000-0000000000bb")!

  nonisolated private static let addressId =
    UUID(uuidString: "00000000-0000-0000-0000-0000000000aa")!

  nonisolated private static let referenceDate =
    Date(timeIntervalSince1970: 1_700_000_000)

  /// Minneapolis, Loring Park-ish.
  nonisolated private static let driverStart = Coordinate(latitude: 44.9778, longitude: -93.2650)
  /// Minneapolis, slightly north — the test dispensary.
  nonisolated private static let dispensaryLocation = Coordinate(latitude: 44.9792, longitude: -93.2638)
  /// Minneapolis, downtown drop.
  nonisolated private static let dropoffLocation = Coordinate(latitude: 44.9836, longitude: -93.2667)

  /// Builds a `DriverOrdersAPIClient` with all five closures defaulting to
  /// `unimplemented`-style throws, overriding only the ones a test drives.
  /// Keeps the per-test wiring focused on the transition under test while
  /// a forgotten override still surfaces as a thrown error.
  nonisolated private static func ordersClient(
    getOrder: @Sendable @escaping (UUID) async throws -> ActiveRoute = { _ in throw DriverAPIError.unimplemented("getOrder") },
    pickupConfirm: @Sendable @escaping (UUID, DriverPickupConfirmRequestDTO) async throws -> ActiveRoute = { _, _ in throw DriverAPIError.unimplemented("pickupConfirm") },
    depart: @Sendable @escaping (UUID, DriverDepartRequestDTO) async throws -> ActiveRoute = { _, _ in throw DriverAPIError.unimplemented("depart") },
    arrive: @Sendable @escaping (UUID, DriverArriveRequestDTO) async throws -> ActiveRoute = { _, _ in throw DriverAPIError.unimplemented("arrive") },
    deliveryConfirm: @Sendable @escaping (UUID, DriverDeliveryConfirmRequestDTO) async throws -> ActiveRoute = { _, _ in throw DriverAPIError.unimplemented("deliveryConfirm") }
  ) -> DriverOrdersAPIClient {
    DriverOrdersAPIClient(
      getOrder: getOrder,
      pickupConfirm: pickupConfirm,
      depart: depart,
      arrive: arrive,
      deliveryConfirm: deliveryConfirm
    )
  }

  nonisolated private static func activeRoute(
    status: OrderStatus = .driverAssigned,
    hasPickupEvent: Bool = false,
    idScanPassed: Bool = false,
    events: [OrderEvent]? = nil
  ) -> ActiveRoute {
    let order = Order(
      id: orderId,
      shortCode: "ABC123",
      userId: userId,
      dispensaryId: dispensaryId,
      deliveryAddressId: addressId,
      status: status,
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
    let resolvedEvents: [OrderEvent]
    if let events {
      resolvedEvents = events
    } else if hasPickupEvent {
      resolvedEvents = [
        OrderEvent(
          id: UUID(uuidString: "00000000-0000-0000-0000-00000000aaaa")!,
          orderId: orderId,
          eventType: "order_pickup_confirmed",
          actorUserId: driverId,
          actorRole: "driver",
          payload: .null,
          occurredAt: referenceDate
        )
      ]
    } else {
      resolvedEvents = []
    }
    return ActiveRoute(
      order: order,
      customer: DriverHandoffCustomer(firstName: "Sam", lastName: "Jefferson", maskedPhone: "(555) 555-0123"),
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
      idScan: DeliveryHandoff(
        orderId: orderId,
        passed: idScanPassed,
        verificationId: idScanPassed ? "veriff-abc-123" : nil,
        scannedAt: idScanPassed ? referenceDate : nil
      ),
      events: resolvedEvents
    )
  }

  nonisolated private static func fixedDirections(
    stepInstruction: String = "Head north on 1st Ave"
  ) -> RouteDirections {
    RouteDirections(
      polyline: [driverStart, dispensaryLocation, dropoffLocation],
      steps: [
        RouteStep(
          id: 0,
          instruction: stepInstruction,
          notice: nil,
          distanceMeters: 120,
          polyline: [driverStart, Coordinate(latitude: 44.9785, longitude: -93.2640)]
        ),
        RouteStep(
          id: 1,
          instruction: "Turn right on Hennepin Ave",
          notice: nil,
          distanceMeters: 240,
          polyline: [Coordinate(latitude: 44.9785, longitude: -93.2640), Coordinate(latitude: 44.9820, longitude: -93.2645)]
        ),
        RouteStep(
          id: 2,
          instruction: "Arrive at destination",
          notice: nil,
          distanceMeters: 60,
          polyline: [Coordinate(latitude: 44.9820, longitude: -93.2645), dropoffLocation]
        ),
      ],
      expectedTravelTimeSeconds: 240,
      distanceMeters: 420
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
  /// binding being touched. `continuousClock` is a `TestClock` that no
  /// test advances, so the 15s handoff poll suspends and is torn down via
  /// `.onDisappear`. `driverRealtimeClient` is `.unimplemented`: publish
  /// is a no-op and the event stream finishes immediately, so the socket
  /// subscription never hangs a `finish()`.
  static func disableDependencies(_ values: inout DependencyValues) {
    values.driverOrdersAPIClient = .unimplemented
    values.driverRealtimeClient = .unimplemented
    values.directionsClient = .unimplemented
    values.backgroundLocationClient = .unimplemented
    values.continuousClock = TestClock()
    values.date = .constant(Date(timeIntervalSince1970: 1_700_000_000))
  }
}

// MARK: - Helpers

private struct CalculateCall: Sendable, Equatable {
  let from: Coordinate
  let to: Coordinate
  let transport: RouteTransportType
}

private struct PickupCall: Sendable, Equatable {
  let orderId: UUID
  let hasLocation: Bool
}

private actor Locker<T: Sendable> {
  private(set) var value: T
  init(value: T) { self.value = value }
}

private extension Locker where T == [UUID] {
  func append(_ id: UUID) { value.append(id) }
}

private extension Locker where T == [Coordinate] {
  func append(_ coord: Coordinate) { value.append(coord) }
}

private extension Locker where T == [CalculateCall] {
  func append(_ call: CalculateCall) { value.append(call) }
}

private extension Locker where T == [PickupCall] {
  func append(_ call: PickupCall) { value.append(call) }
}
