import XCTest
import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

/// Reducer coverage for the driver active-route screen.
///
/// The reducer fans out THREE concurrent effects on `.onAppear`: a
/// route fetch, a location stream subscription, and (when both arrive)
/// a directions calc. We use `exhaustivity = .off` for the merge
/// orderings and assert end-state explicitly. The `BackgroundLocationClient.test`
/// factory replays a fixed coordinate list then closes the stream, so
/// each test deterministically controls how many GPS samples land.
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
      $0.driverOrdersAPIClient = DriverOrdersAPIClient(
        getOrder: { id in
          await getOrderCalls.append(id)
          return initialRoute
        },
        pickupConfirm: { _, _ in throw DriverAPIError.unimplemented("pickupConfirm") },
        deliveryConfirm: { _, _ in throw DriverAPIError.unimplemented("deliveryConfirm") }
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
      $0.driverOrdersAPIClient = DriverOrdersAPIClient(
        getOrder: { _ in throw APIError.transport(NSError(domain: "URLSession", code: -1009)) },
        pickupConfirm: { _, _ in throw DriverAPIError.unimplemented("pickupConfirm") },
        deliveryConfirm: { _, _ in throw DriverAPIError.unimplemented("deliveryConfirm") }
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

  func test_onAppear_deepLinkAfterPickupConfirmed_landsOnDropoffPhase() async {
    let orderId = Self.orderId
    let pickupEvent = OrderEvent(
      id: UUID(uuidString: "00000000-0000-0000-0000-0000000000aa")!,
      orderId: orderId,
      eventType: "order_pickup_confirmed",
      actorUserId: nil,
      actorRole: "driver",
      payload: .null,
      occurredAt: Self.referenceDate
    )
    let route = Self.activeRoute(events: [pickupEvent])
    let directions = Self.fixedDirections()
    let calculateCalls = Locker<[CalculateCall]>(value: [])

    let store = TestStore(
      initialState: ActiveRouteFeature.State(orderId: orderId)
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOrdersAPIClient = DriverOrdersAPIClient(
        getOrder: { _ in route },
        pickupConfirm: { _, _ in throw DriverAPIError.unimplemented("pickupConfirm") },
        deliveryConfirm: { _, _ in throw DriverAPIError.unimplemented("deliveryConfirm") }
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

    XCTAssertEqual(store.state.phase, .enRouteToDropoff)
    let calculated = await calculateCalls.value
    XCTAssertEqual(calculated.first?.to, Self.dropoffLocation, "second-launch should route to dropoff, not dispensary")
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
      $0.driverOrdersAPIClient = DriverOrdersAPIClient(
        getOrder: { _ in initialRoute },
        pickupConfirm: { _, _ in throw DriverAPIError.unimplemented("pickupConfirm") },
        deliveryConfirm: { _, _ in throw DriverAPIError.unimplemented("deliveryConfirm") }
      )
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
      $0.driverOrdersAPIClient = DriverOrdersAPIClient(
        getOrder: { _ in initialRoute },
        pickupConfirm: { _, _ in throw DriverAPIError.unimplemented("pickupConfirm") },
        deliveryConfirm: { _, _ in throw DriverAPIError.unimplemented("deliveryConfirm") }
      )
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

  // MARK: - Confirm Pickup

  func test_confirmPickup_happyPath_flipsLegAndRefetchesDirections() async {
    let orderId = Self.orderId
    let initialRoute = Self.activeRoute()
    let pickupResponse = Self.activeRoute(status: .enRoutePickup, hasPickupEvent: true)
    let toPickupDirections = Self.fixedDirections()
    let toDropoffDirections = Self.fixedDirections(
      stepInstruction: "Turn LEFT on Lake Street"
    )
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
      $0.driverOrdersAPIClient = DriverOrdersAPIClient(
        getOrder: { _ in throw DriverAPIError.unimplemented("getOrder") },
        pickupConfirm: { id, body in
          await pickupCalls.append(PickupCall(orderId: id, hasLocation: body.location != nil))
          return pickupResponse
        },
        deliveryConfirm: { _, _ in throw DriverAPIError.unimplemented("deliveryConfirm") }
      )
      $0.directionsClient = DirectionsClient(
        calculateRoute: { from, to, transport in
          await calculateCalls.append(CalculateCall(from: from, to: to, transport: transport))
          return toDropoffDirections
        },
        liveSteps: { _, _ in AsyncStream { $0.finish() } }
      )
      $0.backgroundLocationClient = .test(status: .authorizedAlways, coordinates: [])
      $0.date = .constant(Self.referenceDate)
    }
    store.exhaustivity = .off

    await store.send(.confirmPickupTapped)
    await store.skipReceivedActions()
    await store.finish()

    XCTAssertEqual(store.state.phase, .enRouteToDropoff)
    XCTAssertEqual(store.state.route, pickupResponse)
    XCTAssertEqual(store.state.directions, toDropoffDirections)
    XCTAssertFalse(store.state.confirmPickupInFlight)
    XCTAssertNil(store.state.errorBanner)

    let recordedPickup = await pickupCalls.value
    XCTAssertEqual(recordedPickup.count, 1)
    XCTAssertEqual(recordedPickup.first?.orderId, orderId)
    XCTAssertTrue(recordedPickup.first?.hasLocation ?? false)

    let calculated = await calculateCalls.value
    XCTAssertEqual(calculated.count, 1)
    XCTAssertEqual(calculated.first?.from, Self.driverStart)
    XCTAssertEqual(calculated.first?.to, Self.dropoffLocation)
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
      $0.driverOrdersAPIClient = DriverOrdersAPIClient(
        getOrder: { id in
          await getOrderCalls.append(id)
          return refetched
        },
        pickupConfirm: { _, _ in
          throw APIError.server(
            status: 409,
            envelope: Self.envelope(code: "ORDER_STATE_INVALID")
          )
        },
        deliveryConfirm: { _, _ in throw DriverAPIError.unimplemented("deliveryConfirm") }
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
    await store.finish()

    XCTAssertFalse(store.state.confirmPickupInFlight)
    XCTAssertNil(store.state.errorBanner, "409 ORDER_STATE_INVALID should refetch, not banner")
    XCTAssertEqual(store.state.route, refetched)
    let fetchedIds = await getOrderCalls.value
    XCTAssertEqual(fetchedIds, [orderId])
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
      $0.driverOrdersAPIClient = DriverOrdersAPIClient(
        getOrder: { _ in throw DriverAPIError.unimplemented("getOrder") },
        pickupConfirm: { _, _ in
          throw APIError.server(
            status: 500,
            envelope: Self.envelope(code: "INTERNAL_ERROR", message: "boom")
          )
        },
        deliveryConfirm: { _, _ in throw DriverAPIError.unimplemented("deliveryConfirm") }
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

  // MARK: - Arrived

  func test_arrivedTapped_atDropoffPhase_emitsRequestedIdScanDelegate() async {
    let orderId = Self.orderId
    let route = Self.activeRoute(status: .enRoutePickup, hasPickupEvent: true)

    let store = TestStore(
      initialState: ActiveRouteFeature.State(
        orderId: orderId,
        route: route,
        driverLocation: Self.dropoffLocation,
        phase: .enRouteToDropoff,
        isLoadingRoute: false
      )
    ) {
      ActiveRouteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.arrivedTapped) {
      $0.phase = .awaitingIdScan
    }
    await store.receive(\.delegate.requestedIdScan)
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
      $0.driverOrdersAPIClient = DriverOrdersAPIClient(
        getOrder: { id in
          await getOrderCalls.append(id)
          return route
        },
        pickupConfirm: { _, _ in throw DriverAPIError.unimplemented("pickupConfirm") },
        deliveryConfirm: { _, _ in throw DriverAPIError.unimplemented("deliveryConfirm") }
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

  func test_derivedInitialPhase_pickupConfirmed_returnsEnRouteToDropoff() {
    let route = Self.activeRoute(status: .enRoutePickup, hasPickupEvent: true)
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
  /// binding being touched.
  static func disableDependencies(_ values: inout DependencyValues) {
    values.driverOrdersAPIClient = .unimplemented
    values.directionsClient = .unimplemented
    values.backgroundLocationClient = .unimplemented
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

private extension Locker where T == [CalculateCall] {
  func append(_ call: CalculateCall) { value.append(call) }
}

private extension Locker where T == [PickupCall] {
  func append(_ call: PickupCall) { value.append(call) }
}
