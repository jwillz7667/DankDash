import XCTest
import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork
import DankDashStorage
@testable import DankDashFeatures

@MainActor
final class DriverShiftFeatureTests: XCTestCase {

  // MARK: - onAppear

  func test_onAppear_loadsDriverEarningsSnapshotAndAuth() async {
    let driver = Self.passedDriver()
    let earnings = Self.todayEarnings()
    let snapshot = Self.activeSnapshot()
    let store = TestStore(initialState: DriverShiftFeature.State()) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverAppAPIClient = DriverAppAPIClient(
        getMe: { driver },
        getCurrentRoute: { throw DriverAPIError.unimplemented("getCurrentRoute") },
        getEarnings: { _ in earnings },
        getShifts: { throw DriverAPIError.unimplemented("getShifts") }
      )
      $0.backgroundLocationClient = .test(status: .authorizedAlways)
      $0.driverSessionStoreClient = DriverSessionStoreClient(
        read: { snapshot },
        write: { _ in },
        updateHeartbeat: { _, _, _ in },
        clear: {}
      )
      $0.batteryMonitorClient = .test(
        initial: BatterySnapshot(level: 0.85, state: .unplugged, isLowPowerModeEnabled: false)
      )
    }
    // `.merge` over five concurrent effects yields actions in scheduling
    // order, not necessarily definition order — switch to non-exhaustive
    // and assert the final state instead of the action sequence.
    store.exhaustivity = .off

    await store.send(.onAppear)
    await store.skipReceivedActions()

    XCTAssertEqual(store.state.driver, driver)
    XCTAssertEqual(store.state.earningsToday, earnings)
    XCTAssertEqual(store.state.locationAuth, .authorizedAlways)
    XCTAssertEqual(
      store.state.batterySnapshot,
      BatterySnapshot(level: 0.85, state: .unplugged, isLowPowerModeEnabled: false)
    )
    // session-store snapshot resurrected an activeShift but the server
    // says offline — the reducer tears the optimistic state back down
    XCTAssertNil(store.state.activeShift)
    XCTAssertFalse(store.state.isLoadingDriver)
    XCTAssertFalse(store.state.isLoadingEarnings)
    await store.finish()
  }

  func test_onAppear_endpointNotYetAvailable_suppressesBanner() async {
    let store = TestStore(initialState: DriverShiftFeature.State()) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverAppAPIClient = DriverAppAPIClient(
        getMe: { throw DriverAppAPIError.endpointNotYetAvailable },
        getCurrentRoute: { throw DriverAPIError.unimplemented("getCurrentRoute") },
        getEarnings: { _ in throw DriverAppAPIError.endpointNotYetAvailable },
        getShifts: { throw DriverAPIError.unimplemented("getShifts") }
      )
    }
    store.exhaustivity = .off

    await store.send(.onAppear)
    await store.skipReceivedActions()

    XCTAssertNil(store.state.errorBanner, "endpointNotYetAvailable suppresses the banner")
    XCTAssertFalse(store.state.isLoadingDriver)
    XCTAssertFalse(store.state.isLoadingEarnings)
    await store.finish()
  }

  // MARK: - Toggle online — rationale + authorization

  func test_toggleOnline_notDetermined_showsRationale() async {
    let store = TestStore(
      initialState: DriverShiftFeature.State(locationAuth: .notDetermined)
    ) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.toggleOnlineTapped) {
      $0.isShowingLocationRationale = true
    }
  }

  func test_toggleOnline_denied_surfacesSettingsBanner() async {
    let store = TestStore(
      initialState: DriverShiftFeature.State(locationAuth: .denied)
    ) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.toggleOnlineTapped) {
      $0.errorBanner = "Enable Always location in Settings to go online."
    }
  }

  func test_rationaleAllowTapped_requestsAuthAndStartsShift() async {
    let shift = Self.openShift()
    let driver = Self.passedDriver()
    let store = TestStore(
      initialState: DriverShiftFeature.State(
        driver: driver,
        currentCoordinate: Coordinate(latitude: 44.9778, longitude: -93.2650),
        locationAuth: .notDetermined,
        isShowingLocationRationale: true
      )
    ) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.backgroundLocationClient = .test(status: .authorizedAlways)
      $0.driverShiftAPIClient = DriverShiftAPIClient(
        startShift: { _ in shift },
        endShift: { _ in throw DriverAPIError.unimplemented("endShift") },
        updateStatus: { _ in throw DriverAPIError.unimplemented("updateStatus") }
      )
      $0.driverSessionStoreClient = DriverSessionStoreClient(
        read: { nil },
        write: { _ in },
        updateHeartbeat: { _, _, _ in },
        clear: {}
      )
      $0.continuousClock = TestClock()
      $0.date = .constant(Date(timeIntervalSince1970: 1_700_000_000))
    }
    // After shiftStarted the reducer fans out side effects (location
    // stream + heatmap timer + heartbeat timer); we test only that the
    // state lands correctly and skip the in-flight long-running ones.
    store.exhaustivity = .off

    await store.send(.locationRationaleAllowTapped) {
      $0.isShowingLocationRationale = false
    }
    await store.skipReceivedActions()

    XCTAssertEqual(store.state.locationAuth, .authorizedAlways)
    XCTAssertEqual(store.state.activeShift, shift)
    XCTAssertEqual(store.state.driver?.currentStatus, .online)
    XCTAssertFalse(store.state.isPerformingShiftTransition)
    XCTAssertNil(store.state.errorBanner)

    await store.skipInFlightEffects()
  }

  func test_rationaleDismissed_clearsFlag() async {
    let store = TestStore(
      initialState: DriverShiftFeature.State(isShowingLocationRationale: true)
    ) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.locationRationaleDismissed) {
      $0.isShowingLocationRationale = false
    }
  }

  func test_rationaleAllow_whenInUseGrant_surfacesBanner() async {
    let store = TestStore(
      initialState: DriverShiftFeature.State(locationAuth: .notDetermined, isShowingLocationRationale: true)
    ) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.backgroundLocationClient = .test(status: .authorizedWhenInUse)
    }

    await store.send(.locationRationaleAllowTapped) {
      $0.isShowingLocationRationale = false
    }
    await store.receive(\.authorizationRequestCompleted) {
      $0.locationAuth = .authorizedWhenInUse
      $0.errorBanner = "While Using is not enough — choose Always in Settings to go online."
    }
  }

  // MARK: - Toggle offline (already online)

  func test_toggleOffline_endsShiftAndClearsState() async {
    let shift = Self.openShift()
    let endedShift = DriverShift(
      id: shift.id,
      driverId: shift.driverId,
      startedAt: shift.startedAt,
      endedAt: Date(timeIntervalSince1970: 1_700_003_600),
      startingLocation: shift.startingLocation,
      endingLocation: Coordinate(latitude: 44.97, longitude: -93.26),
      totalMiles: Decimal(string: "12.4"),
      totalDeliveries: 2,
      totalEarningsCents: 4_250
    )
    let earnings = Self.todayEarnings()
    let store = TestStore(
      initialState: DriverShiftFeature.State(
        driver: Self.passedDriver(currentStatus: .online),
        activeShift: shift,
        earningsToday: earnings,
        currentCoordinate: Coordinate(latitude: 44.97, longitude: -93.26),
        locationAuth: .authorizedAlways
      )
    ) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverShiftAPIClient = DriverShiftAPIClient(
        startShift: { _ in throw DriverAPIError.unimplemented("startShift") },
        endShift: { _ in endedShift },
        updateStatus: { _ in throw DriverAPIError.unimplemented("updateStatus") }
      )
      $0.driverSessionStoreClient = DriverSessionStoreClient(
        read: { nil },
        write: { _ in },
        updateHeartbeat: { _, _, _ in },
        clear: {}
      )
      $0.date = .constant(Date(timeIntervalSince1970: 1_700_003_600))
    }

    await store.send(.toggleOnlineTapped) {
      $0.isPerformingShiftTransition = true
    }
    await store.receive(\.shiftEnded.success) {
      $0.isPerformingShiftTransition = false
      $0.activeShift = nil
      $0.heatmap = []
      $0.locationMode = .standard(accuracy: .balanced)
      $0.earningsToday = DriverEarnings(
        period: earnings.period,
        since: earnings.since,
        until: earnings.until,
        tipsCents: earnings.tipsCents,
        deliveryFeesCents: earnings.deliveryFeesCents,
        deliveriesCount: earnings.deliveriesCount + 2,
        totalCents: earnings.totalCents + 4_250
      )
      $0.driver = Self.passedDriver(
        currentStatus: .offline,
        lastStatusChangeAt: Date(timeIntervalSince1970: 1_700_003_600)
      )
    }
  }

  func test_toggleOffline_endShiftFailure_restartsSideEffects() async {
    let shift = Self.openShift()
    let store = TestStore(
      initialState: DriverShiftFeature.State(
        driver: Self.passedDriver(currentStatus: .online),
        activeShift: shift,
        currentCoordinate: Coordinate(latitude: 44.97, longitude: -93.26),
        locationAuth: .authorizedAlways
      )
    ) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverShiftAPIClient = DriverShiftAPIClient(
        startShift: { _ in throw DriverAPIError.unimplemented("startShift") },
        endShift: { _ in throw DriverAPIError.unimplemented("endShift") },
        updateStatus: { _ in throw DriverAPIError.unimplemented("updateStatus") }
      )
      $0.continuousClock = TestClock()
    }
    store.exhaustivity = .off

    await store.send(.toggleOnlineTapped) {
      $0.isPerformingShiftTransition = true
    }
    await store.skipReceivedActions()

    XCTAssertFalse(store.state.isPerformingShiftTransition)
    XCTAssertNotNil(store.state.activeShift, "shift stays open until endShift returns success")
    XCTAssertEqual(store.state.errorBanner, "This is not available yet.")
    await store.skipInFlightEffects()
  }

  // MARK: - Location samples

  func test_locationReceived_updatesCurrentCoordinate() async {
    let received = Coordinate(latitude: 44.95, longitude: -93.10)
    let store = TestStore(initialState: DriverShiftFeature.State()) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.locationReceived(received)) {
      $0.currentCoordinate = received
    }
  }

  // MARK: - Battery-aware mode switch

  func test_batterySnapshot_lowLevel_flipsToSignificantChange() async {
    let lowBattery = BatterySnapshot(level: 0.15, state: .unplugged, isLowPowerModeEnabled: false)
    let setModes = Locker<[LocationUpdateMode]>(value: [])
    let store = TestStore(
      initialState: DriverShiftFeature.State(
        driver: Self.passedDriver(currentStatus: .online),
        activeShift: Self.openShift(),
        locationMode: .standard(accuracy: .balanced)
      )
    ) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.backgroundLocationClient = BackgroundLocationClient(
        authorizationStatus: { .authorizedAlways },
        requestAlwaysAuthorization: { .authorizedAlways },
        beginUpdates: { _ in },
        endUpdates: { },
        setUpdateMode: { mode in await setModes.append(mode) },
        locationUpdates: { AsyncStream { $0.finish() } }
      )
    }

    await store.send(.batterySnapshotChanged(lowBattery)) {
      $0.batterySnapshot = lowBattery
      $0.locationMode = .significantChange
    }
    await store.finish()
    let captured = await setModes.value
    XCTAssertEqual(captured, [.significantChange])
  }

  func test_batterySnapshot_healthy_keepsStandard() async {
    let healthy = BatterySnapshot(level: 0.85, state: .unplugged, isLowPowerModeEnabled: false)
    let setModes = Locker<[LocationUpdateMode]>(value: [])
    let store = TestStore(
      initialState: DriverShiftFeature.State(
        locationMode: .standard(accuracy: .balanced)
      )
    ) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.backgroundLocationClient = BackgroundLocationClient(
        authorizationStatus: { .authorizedAlways },
        requestAlwaysAuthorization: { .authorizedAlways },
        beginUpdates: { _ in },
        endUpdates: { },
        setUpdateMode: { mode in await setModes.append(mode) },
        locationUpdates: { AsyncStream { $0.finish() } }
      )
    }

    await store.send(.batterySnapshotChanged(healthy)) {
      $0.batterySnapshot = healthy
    }
    await store.finish()
    let captured = await setModes.value
    XCTAssertEqual(captured, [], "healthy battery with mode already .standard should not push a new mode")
  }

  // MARK: - Heatmap ticks

  func test_heatmapTick_success_populatesCells() async {
    let cells = [
      DemandHeatmapCell(
        cellId: "h1",
        polygon: [Coordinate(latitude: 44.97, longitude: -93.26)],
        demandScore: Decimal(string: "0.75")!
      )
    ]
    let store = TestStore(
      initialState: DriverShiftFeature.State(
        currentCoordinate: Coordinate(latitude: 44.97, longitude: -93.26)
      )
    ) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverHeatmapAPIClient = DriverHeatmapAPIClient(
        getHeatmap: { _, _ in cells }
      )
    }

    await store.send(.heatmapTick)
    await store.receive(\.heatmapLoaded.success) {
      $0.heatmap = cells
    }
  }

  func test_heatmapTick_endpointMissing_silentNoBanner() async {
    let store = TestStore(
      initialState: DriverShiftFeature.State(
        heatmap: [
          DemandHeatmapCell(
            cellId: "stale",
            polygon: [Coordinate(latitude: 44.97, longitude: -93.26)],
            demandScore: Decimal(string: "0.1")!
          )
        ],
        currentCoordinate: Coordinate(latitude: 44.97, longitude: -93.26)
      )
    ) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      // The convenience overload wraps the closure; throwing an APIError
      // 404 simulates the "endpoint not yet built" path the live binding
      // collapses to empty cells. Here we go through the throwing path
      // directly so the reducer's ShiftErrorBox sees `.transport`/`.other`
      // — and asserts the no-banner contract.
      $0.driverHeatmapAPIClient = DriverHeatmapAPIClient(
        getHeatmap: { _, _ in throw DriverAPIError.unimplemented("getHeatmap") }
      )
    }

    await store.send(.heatmapTick)
    await store.receive(\.heatmapLoaded.failure) {
      $0.heatmap = []
    }
    XCTAssertNil(store.state.errorBanner, "heatmap failures stay silent — they're a read-side overlay")
  }

  func test_heatmapTick_noCoordinate_isNoOp() async {
    let store = TestStore(initialState: DriverShiftFeature.State()) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.heatmapTick)
  }

  // MARK: - Heartbeat tick

  func test_heartbeatTick_updatesSessionStoreAndStatus() async {
    let updates = Locker<[HeartbeatRecord]>(value: [])
    let statuses = Locker<[SelfSettableDriverStatus]>(value: [])
    let coord = Coordinate(latitude: 44.97, longitude: -93.26)
    let store = TestStore(
      initialState: DriverShiftFeature.State(
        driver: Self.passedDriver(currentStatus: .online),
        activeShift: Self.openShift(),
        currentCoordinate: coord
      )
    ) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverShiftAPIClient = DriverShiftAPIClient(
        startShift: { _ in throw DriverAPIError.unimplemented("startShift") },
        endShift: { _ in throw DriverAPIError.unimplemented("endShift") },
        updateStatus: { status in
          await statuses.append(status)
          return Self.passedDriver(currentStatus: .online)
        }
      )
      $0.driverSessionStoreClient = DriverSessionStoreClient(
        read: { nil },
        write: { _ in },
        updateHeartbeat: { lat, lng, at in
          await updates.append(HeartbeatRecord(lat: lat, lng: lng, at: at))
        },
        clear: {}
      )
      $0.date = .constant(Date(timeIntervalSince1970: 1_700_000_000))
    }

    await store.send(.heartbeatTick)
    await store.finish()
    let recordedUpdates = await updates.value
    let recordedStatuses = await statuses.value
    XCTAssertEqual(recordedUpdates.count, 1)
    XCTAssertEqual(recordedUpdates.first?.lat, 44.97)
    XCTAssertEqual(recordedUpdates.first?.lng, -93.26)
    XCTAssertEqual(recordedUpdates.first?.at, Date(timeIntervalSince1970: 1_700_000_000))
    XCTAssertEqual(recordedStatuses, [.online])
  }

  func test_heartbeatTick_offline_isNoOp() async {
    let store = TestStore(initialState: DriverShiftFeature.State()) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.heartbeatTick)
  }

  // MARK: - Status menu

  func test_statusMenuTapped_opensSheet() async {
    let store = TestStore(initialState: DriverShiftFeature.State()) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.statusMenuTapped) {
      $0.isShowingStatusMenu = true
    }
    await store.send(.statusMenuDismissed) {
      $0.isShowingStatusMenu = false
    }
  }

  func test_statusOptionTapped_postsToServerAndUpdatesDriver() async {
    let onBreakDriver = Self.passedDriver(currentStatus: .onBreak)
    let store = TestStore(
      initialState: DriverShiftFeature.State(
        driver: Self.passedDriver(currentStatus: .online),
        isShowingStatusMenu: true
      )
    ) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverShiftAPIClient = DriverShiftAPIClient(
        startShift: { _ in throw DriverAPIError.unimplemented("startShift") },
        endShift: { _ in throw DriverAPIError.unimplemented("endShift") },
        updateStatus: { _ in onBreakDriver }
      )
    }

    await store.send(.statusOptionTapped(.onBreak)) {
      $0.isShowingStatusMenu = false
    }
    await store.receive(\.statusUpdated.success) {
      $0.driver = onBreakDriver
    }
  }

  // MARK: - Misc UI

  func test_errorBannerDismissed_clearsBanner() async {
    let store = TestStore(
      initialState: DriverShiftFeature.State(errorBanner: "oops")
    ) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.errorBannerDismissed) {
      $0.errorBanner = nil
    }
  }

  func test_earningsCardTapped_firesDelegate() async {
    let store = TestStore(initialState: DriverShiftFeature.State()) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.earningsCardTapped)
    await store.receive(\.delegate.openEarningsDetail)
  }

  // MARK: - Dispatch offer subscription

  func test_offerReceived_whileOnline_presentsOfferSheet() async {
    let offer = Self.offer(expiresAt: Date(timeIntervalSince1970: 1_700_000_030))
    let store = TestStore(
      initialState: DriverShiftFeature.State(
        driver: Self.passedDriver(currentStatus: .online),
        activeShift: Self.openShift()
      )
    ) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.offerReceived(offer)) {
      $0.presentedOffer = DispatchOfferFeature.State(offer: offer)
    }
  }

  func test_offerReceived_whileOffline_isNoOp() async {
    let offer = Self.offer(expiresAt: Date(timeIntervalSince1970: 1_700_000_030))
    let store = TestStore(initialState: DriverShiftFeature.State()) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.offerReceived(offer))
    XCTAssertNil(store.state.presentedOffer)
  }

  func test_offerReceived_duplicateId_doesNotReseatSheet() async {
    let offer = Self.offer(expiresAt: Date(timeIntervalSince1970: 1_700_000_030))
    let store = TestStore(
      initialState: DriverShiftFeature.State(
        driver: Self.passedDriver(currentStatus: .online),
        activeShift: Self.openShift(),
        presentedOffer: DispatchOfferFeature.State(offer: offer, secondsRemaining: 12)
      )
    ) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.offerReceived(offer))
    XCTAssertEqual(
      store.state.presentedOffer?.secondsRemaining,
      12,
      "duplicate-id yield must not stomp the in-flight countdown"
    )
  }

  func test_offerReceived_freshOfferWhileSheetActive_refusesToStack() async {
    let presented = Self.offer(
      id: UUID(uuidString: "00000000-0000-0000-0000-0000000000f1")!,
      expiresAt: Date(timeIntervalSince1970: 1_700_000_030)
    )
    let arriving = Self.offer(
      id: UUID(uuidString: "00000000-0000-0000-0000-0000000000f2")!,
      expiresAt: Date(timeIntervalSince1970: 1_700_000_060)
    )
    let store = TestStore(
      initialState: DriverShiftFeature.State(
        driver: Self.passedDriver(currentStatus: .online),
        activeShift: Self.openShift(),
        presentedOffer: DispatchOfferFeature.State(offer: presented)
      )
    ) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.offerReceived(arriving))
    XCTAssertEqual(
      store.state.presentedOffer?.offer.id,
      presented.id,
      "the existing sheet wins; the fresh offer waits its turn"
    )
  }

  func test_presentedOfferAcceptedDelegate_emitsAcceptedOrderAndClearsSheet() async {
    let offer = Self.offer(expiresAt: Date(timeIntervalSince1970: 1_700_000_030))
    let store = TestStore(
      initialState: DriverShiftFeature.State(
        driver: Self.passedDriver(currentStatus: .online),
        activeShift: Self.openShift(),
        presentedOffer: DispatchOfferFeature.State(offer: offer)
      )
    ) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    store.exhaustivity = .off

    await store.send(.presentedOffer(.delegate(.accepted(offer))))
    await store.skipReceivedActions()
    XCTAssertNil(store.state.presentedOffer, "accept delegate clears the presented offer")
  }

  func test_presentedOfferTerminalDelegates_clearSheet() async {
    let offer = Self.offer(expiresAt: Date(timeIntervalSince1970: 1_700_000_030))
    let terminals: [DispatchOfferFeature.Action.Delegate] = [
      .declined(offerId: offer.id),
      .expired(offerId: offer.id),
      .unavailable(offerId: offer.id),
    ]
    for terminal in terminals {
      let store = TestStore(
        initialState: DriverShiftFeature.State(
          driver: Self.passedDriver(currentStatus: .online),
          activeShift: Self.openShift(),
          presentedOffer: DispatchOfferFeature.State(offer: offer)
        )
      ) {
        DriverShiftFeature()
      } withDependencies: {
        Self.disableDependencies(&$0)
      }
      store.exhaustivity = .off

      await store.send(.presentedOffer(.delegate(terminal)))
      XCTAssertNil(store.state.presentedOffer, "terminal delegate \(terminal) must clear sheet")
    }
  }

  func test_offerSheetDismissed_clearsPresentedOffer() async {
    let offer = Self.offer(expiresAt: Date(timeIntervalSince1970: 1_700_000_030))
    let store = TestStore(
      initialState: DriverShiftFeature.State(
        driver: Self.passedDriver(currentStatus: .online),
        activeShift: Self.openShift(),
        presentedOffer: DispatchOfferFeature.State(offer: offer)
      )
    ) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.offerSheetDismissed) {
      $0.presentedOffer = nil
    }
  }

  func test_toggleOffline_clearsPresentedOffer_andCancelsStream() async {
    let offer = Self.offer(expiresAt: Date(timeIntervalSince1970: 1_700_000_030))
    let shift = Self.openShift()
    let endedShift = DriverShift(
      id: shift.id,
      driverId: shift.driverId,
      startedAt: shift.startedAt,
      endedAt: Date(timeIntervalSince1970: 1_700_003_600),
      startingLocation: shift.startingLocation,
      endingLocation: nil,
      totalMiles: nil,
      totalDeliveries: 0,
      totalEarningsCents: 0
    )
    let store = TestStore(
      initialState: DriverShiftFeature.State(
        driver: Self.passedDriver(currentStatus: .online),
        activeShift: shift,
        locationAuth: .authorizedAlways,
        presentedOffer: DispatchOfferFeature.State(offer: offer)
      )
    ) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverShiftAPIClient = DriverShiftAPIClient(
        startShift: { _ in throw DriverAPIError.unimplemented("startShift") },
        endShift: { _ in endedShift },
        updateStatus: { _ in throw DriverAPIError.unimplemented("updateStatus") }
      )
      $0.driverSessionStoreClient = DriverSessionStoreClient(
        read: { nil },
        write: { _ in },
        updateHeartbeat: { _, _, _ in },
        clear: {}
      )
    }
    store.exhaustivity = .off

    await store.send(.toggleOnlineTapped) {
      $0.isPerformingShiftTransition = true
      $0.presentedOffer = nil
    }
    await store.skipReceivedActions()
    XCTAssertNil(store.state.activeShift)
    XCTAssertNil(store.state.presentedOffer)
  }

  func test_offerStreamFinished_isNoOp() async {
    let store = TestStore(
      initialState: DriverShiftFeature.State(
        driver: Self.passedDriver(currentStatus: .online),
        activeShift: Self.openShift()
      )
    ) {
      DriverShiftFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.offerStreamFinished)
    XCTAssertNil(store.state.presentedOffer)
  }

  // MARK: - State helpers

  func test_isOnline_requiresShiftAndOnShiftStatus() {
    var state = DriverShiftFeature.State()
    XCTAssertFalse(state.isOnline)
    state.activeShift = Self.openShift()
    state.driver = Self.passedDriver(currentStatus: .offline)
    XCTAssertFalse(state.isOnline, "shift on disk but server says offline → not online")
    state.driver = Self.passedDriver(currentStatus: .online)
    XCTAssertTrue(state.isOnline)
  }

  func test_isShiftToggleInteractive_blocksDuringActiveDelivery() {
    var state = DriverShiftFeature.State()
    XCTAssertTrue(state.isShiftToggleInteractive)
    state.driver = Self.passedDriver(currentStatus: .enRoutePickup)
    XCTAssertFalse(state.isShiftToggleInteractive, "active delivery blocks toggle")
    state.driver = Self.passedDriver(currentStatus: .online)
    state.isPerformingShiftTransition = true
    XCTAssertFalse(state.isShiftToggleInteractive, "transition in flight blocks toggle")
  }

  // MARK: - Fixtures

  nonisolated private static func passedDriver(
    currentStatus: DriverStatus = .offline,
    lastStatusChangeAt: Date = Date(timeIntervalSince1970: 1_700_000_000)
  ) -> Driver {
    Driver(
      id: UUID(uuidString: "00000000-0000-0000-0000-0000000000d1")!,
      userId: UUID(uuidString: "00000000-0000-0000-0000-0000000000a1")!,
      vehicle: Vehicle(make: "Honda", model: "Civic", year: 2021, plate: "ABC123", color: "Blue"),
      insuranceDocKey: nil,
      insuranceExpiresAt: "2026-01-01",
      backgroundCheckPassedAt: "2024-01-15T12:00:00Z",
      backgroundCheckProviderRef: "veriff-session-abc",
      currentStatus: currentStatus,
      lastStatusChangeAt: lastStatusChangeAt,
      currentLocation: nil,
      currentLocationUpdatedAt: nil,
      currentOrderId: nil,
      ratingAvg: Decimal(string: "4.9"),
      ratingCount: 32,
      totalDeliveries: 64,
      createdAt: Date(timeIntervalSince1970: 1_700_000_000),
      updatedAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
  }

  nonisolated private static func openShift() -> DriverShift {
    DriverShift(
      id: UUID(uuidString: "00000000-0000-0000-0000-0000000000c1")!,
      driverId: UUID(uuidString: "00000000-0000-0000-0000-0000000000d1")!,
      startedAt: Date(timeIntervalSince1970: 1_700_000_000),
      endedAt: nil,
      startingLocation: Coordinate(latitude: 44.9778, longitude: -93.2650),
      endingLocation: nil,
      totalMiles: nil,
      totalDeliveries: 0,
      totalEarningsCents: 0
    )
  }

  nonisolated private static func todayEarnings() -> DriverEarnings {
    DriverEarnings(
      period: .today,
      since: Date(timeIntervalSince1970: 1_699_956_000),
      until: Date(timeIntervalSince1970: 1_700_042_400),
      tipsCents: 1_500,
      deliveryFeesCents: 3_200,
      deliveriesCount: 3,
      totalCents: 4_700
    )
  }

  nonisolated private static func offer(
    id: UUID = UUID(uuidString: "00000000-0000-0000-0000-0000000000f1")!,
    expiresAt: Date,
    status: DispatchOffer.Status = .offered
  ) -> DispatchOffer {
    DispatchOffer(
      id: id,
      orderId: UUID(uuidString: "00000000-0000-0000-0000-0000000000e1")!,
      driverId: UUID(uuidString: "00000000-0000-0000-0000-0000000000d1")!,
      offeredAt: expiresAt.addingTimeInterval(-30),
      expiresAt: expiresAt,
      payoutEstimateCents: 1_250,
      distanceMiles: Decimal(string: "2.4") ?? 0,
      status: status,
      respondedAt: nil,
      declineReason: nil
    )
  }

  nonisolated private static func activeSnapshot() -> DriverSessionStore.Snapshot {
    DriverSessionStore.Snapshot(
      shiftId: UUID(uuidString: "00000000-0000-0000-0000-0000000000c1")!,
      startedAt: Date(timeIntervalSince1970: 1_700_000_000),
      lastKnownLocationLat: 44.9778,
      lastKnownLocationLng: -93.2650,
      lastHeartbeatAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
  }

  /// Wire safe stubs across every dependency so a forgotten override
  /// surfaces as a TestStore "unexpected effect" rather than hitting
  /// the live binding.
  static func disableDependencies(_ values: inout DependencyValues) {
    values.backgroundLocationClient = .unimplemented
    values.batteryMonitorClient = .unimplemented
    values.driverShiftAPIClient = .unimplemented
    values.driverAppAPIClient = .unimplemented
    values.driverHeatmapAPIClient = .unimplemented
    values.driverSessionStoreClient = .unimplemented
    values.dispatchOfferAPIClient = .unimplemented
    values.offerSubscriptionClient = .unimplemented
    values.hapticsClient = .noop
    values.continuousClock = ImmediateClock()
    values.date = .constant(Date(timeIntervalSince1970: 1_700_000_000))
  }
}

// MARK: - Helpers

private struct HeartbeatRecord: Sendable, Equatable {
  let lat: Double?
  let lng: Double?
  let at: Date
}

private actor Locker<T: Sendable> {
  private(set) var value: T
  init(value: T) { self.value = value }
  func set(_ newValue: T) { self.value = newValue }
}

private extension Locker where T == [LocationUpdateMode] {
  func append(_ mode: LocationUpdateMode) { value.append(mode) }
}

private extension Locker where T == [SelfSettableDriverStatus] {
  func append(_ status: SelfSettableDriverStatus) { value.append(status) }
}

private extension Locker where T == [HeartbeatRecord] {
  func append(_ record: HeartbeatRecord) { value.append(record) }
}
