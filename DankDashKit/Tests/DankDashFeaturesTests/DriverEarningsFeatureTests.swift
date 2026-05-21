import XCTest
import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

@MainActor
final class DriverEarningsFeatureTests: XCTestCase {

  // MARK: - onAppear

  func test_onAppear_firstLoad_fetchesEarningsAndShifts() async {
    let earnings = Self.earnings(.today, totalCents: 4_500, deliveries: 3)
    let shifts = [Self.shift(totalEarningsCents: 4_500, totalDeliveries: 3)]
    let store = TestStore(initialState: DriverEarningsFeature.State()) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverAppAPIClient = DriverAppAPIClient(
        getMe: { throw DriverAPIError.unimplemented("getMe") },
        getCurrentRoute: { throw DriverAPIError.unimplemented("getCurrentRoute") },
        getEarnings: { _ in earnings },
        getShifts: { shifts }
      )
    }
    store.exhaustivity = .off

    await store.send(.onAppear) {
      $0.isLoadingEarnings = true
      $0.isLoadingShifts = true
    }
    await store.skipReceivedActions()
    XCTAssertEqual(store.state.earnings, earnings)
    XCTAssertEqual(store.state.shifts, shifts)
    XCTAssertFalse(store.state.isLoadingEarnings)
    XCTAssertFalse(store.state.isLoadingShifts)
    await store.finish()
  }

  func test_onAppear_alreadyLoaded_isNoOp() async {
    let earnings = Self.earnings(.today, totalCents: 4_500, deliveries: 3)
    let store = TestStore(
      initialState: DriverEarningsFeature.State(
        earnings: earnings,
        shifts: [Self.shift()]
      )
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.onAppear)
  }

  // MARK: - Period change

  func test_periodChanged_clearsContentAndRefetches() async {
    let weekEarnings = Self.earnings(.week, totalCents: 18_000, deliveries: 12)
    let weekShifts = [Self.shift(), Self.shift()]
    let store = TestStore(
      initialState: DriverEarningsFeature.State(
        period: .today,
        earnings: Self.earnings(.today, totalCents: 4_500, deliveries: 3),
        shifts: [Self.shift()]
      )
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverAppAPIClient = DriverAppAPIClient(
        getMe: { throw DriverAPIError.unimplemented("getMe") },
        getCurrentRoute: { throw DriverAPIError.unimplemented("getCurrentRoute") },
        getEarnings: { _ in weekEarnings },
        getShifts: { weekShifts }
      )
    }
    store.exhaustivity = .off

    await store.send(.periodChanged(.week)) {
      $0.period = .week
      $0.earnings = nil
      $0.shifts = []
      $0.isLoadingEarnings = true
      $0.isLoadingShifts = true
    }
    await store.skipReceivedActions()
    XCTAssertEqual(store.state.earnings, weekEarnings)
    XCTAssertEqual(store.state.shifts, weekShifts)
  }

  func test_periodChanged_sameValue_isNoOp() async {
    let store = TestStore(
      initialState: DriverEarningsFeature.State(period: .today)
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.periodChanged(.today))
  }

  // MARK: - Pull-to-refresh

  func test_pullToRefresh_fetchesBoth() async {
    let earnings = Self.earnings(.today, totalCents: 6_000, deliveries: 4)
    let shifts = [Self.shift()]
    let store = TestStore(
      initialState: DriverEarningsFeature.State(
        earnings: Self.earnings(.today, totalCents: 4_500, deliveries: 3),
        shifts: []
      )
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverAppAPIClient = DriverAppAPIClient(
        getMe: { throw DriverAPIError.unimplemented("getMe") },
        getCurrentRoute: { throw DriverAPIError.unimplemented("getCurrentRoute") },
        getEarnings: { _ in earnings },
        getShifts: { shifts }
      )
    }
    store.exhaustivity = .off

    await store.send(.pullToRefresh) {
      $0.isRefreshing = true
    }
    await store.skipReceivedActions()
    XCTAssertFalse(store.state.isRefreshing, "isRefreshing flips off after both fetches resolve")
    XCTAssertEqual(store.state.earnings, earnings)
    XCTAssertEqual(store.state.shifts, shifts)
  }

  func test_pullToRefresh_whileLoading_isNoOp() async {
    let store = TestStore(
      initialState: DriverEarningsFeature.State(isLoadingEarnings: true)
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.pullToRefresh)
  }

  // MARK: - Failure paths

  func test_earningsLoaded_serverError_surfacesBanner() async {
    let envelope = ErrorEnvelope(error: .init(code: "INTERNAL", message: "Down for maintenance"))
    let store = TestStore(
      initialState: DriverEarningsFeature.State(
        isLoadingEarnings: true,
        isLoadingShifts: false
      )
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(
      .earningsLoaded(
        .failure(EarningsErrorBox(APIError.server(status: 500, envelope: envelope)))
      )
    ) {
      $0.isLoadingEarnings = false
      $0.errorBanner = "Down for maintenance"
    }
  }

  func test_earningsLoaded_endpointNotYetAvailable_suppressesBanner() async {
    let store = TestStore(
      initialState: DriverEarningsFeature.State(isLoadingEarnings: true)
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(
      .earningsLoaded(
        .failure(EarningsErrorBox(DriverAppAPIError.endpointNotYetAvailable))
      )
    ) {
      $0.isLoadingEarnings = false
    }
    XCTAssertNil(store.state.errorBanner)
  }

  func test_shiftsLoaded_failureWithExistingBanner_doesNotOverwrite() async {
    let store = TestStore(
      initialState: DriverEarningsFeature.State(
        isLoadingShifts: true,
        errorBanner: "Down for maintenance"
      )
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(
      .shiftsLoaded(
        .failure(EarningsErrorBox(DriverAPIError.unimplemented("getShifts")))
      )
    ) {
      $0.isLoadingShifts = false
    }
    XCTAssertEqual(store.state.errorBanner, "Down for maintenance", "earnings banner sticks; shifts failure doesn't overwrite it")
  }

  // MARK: - Retry

  func test_retryTapped_withBanner_refetches() async {
    let earnings = Self.earnings(.today, totalCents: 4_500, deliveries: 3)
    let shifts = [Self.shift()]
    let store = TestStore(
      initialState: DriverEarningsFeature.State(errorBanner: "Down for maintenance")
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverAppAPIClient = DriverAppAPIClient(
        getMe: { throw DriverAPIError.unimplemented("getMe") },
        getCurrentRoute: { throw DriverAPIError.unimplemented("getCurrentRoute") },
        getEarnings: { _ in earnings },
        getShifts: { shifts }
      )
    }
    store.exhaustivity = .off

    await store.send(.retryTapped) {
      $0.isLoadingEarnings = true
      $0.isLoadingShifts = true
      $0.errorBanner = nil
    }
    await store.skipReceivedActions()
    XCTAssertEqual(store.state.earnings, earnings)
  }

  func test_retryTapped_withoutBanner_isNoOp() async {
    let store = TestStore(initialState: DriverEarningsFeature.State()) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.retryTapped)
  }

  // MARK: - Misc UI

  func test_errorBannerDismissed_clearsBanner() async {
    let store = TestStore(
      initialState: DriverEarningsFeature.State(errorBanner: "oops")
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.errorBannerDismissed) {
      $0.errorBanner = nil
    }
  }

  func test_shiftRowTapped_firesDelegate() async {
    let shiftId = UUID()
    let store = TestStore(initialState: DriverEarningsFeature.State()) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.shiftRowTapped(shiftId))
    await store.receive(\.delegate.openShiftDetail)
  }

  // MARK: - State helpers

  func test_isInitialLoading_requiresEmptyContent() {
    var state = DriverEarningsFeature.State(isLoadingEarnings: true)
    XCTAssertTrue(state.isInitialLoading)
    state.earnings = Self.earnings(.today, totalCents: 1, deliveries: 1)
    XCTAssertFalse(state.isInitialLoading, "any content suppresses the initial-loading spinner")
  }

  // MARK: - Fixtures

  nonisolated private static func earnings(
    _ period: EarningsPeriod,
    totalCents: Int,
    deliveries: Int
  ) -> DriverEarnings {
    DriverEarnings(
      period: period,
      since: Date(timeIntervalSince1970: 1_699_956_000),
      until: Date(timeIntervalSince1970: 1_700_042_400),
      tipsCents: totalCents / 3,
      deliveryFeesCents: (totalCents * 2) / 3,
      deliveriesCount: deliveries,
      totalCents: totalCents
    )
  }

  nonisolated private static func shift(
    totalEarningsCents: Int = 1_500,
    totalDeliveries: Int = 1
  ) -> DriverShift {
    DriverShift(
      id: UUID(),
      driverId: UUID(uuidString: "00000000-0000-0000-0000-0000000000d1")!,
      startedAt: Date(timeIntervalSince1970: 1_700_000_000),
      endedAt: Date(timeIntervalSince1970: 1_700_003_600),
      startingLocation: Coordinate(latitude: 44.97, longitude: -93.26),
      endingLocation: Coordinate(latitude: 44.97, longitude: -93.26),
      totalMiles: Decimal(string: "6.2"),
      totalDeliveries: totalDeliveries,
      totalEarningsCents: totalEarningsCents
    )
  }

  static func disableDependencies(_ values: inout DependencyValues) {
    values.driverAppAPIClient = .unimplemented
    values.continuousClock = ImmediateClock()
    values.date = .constant(Date(timeIntervalSince1970: 1_700_000_000))
  }
}
