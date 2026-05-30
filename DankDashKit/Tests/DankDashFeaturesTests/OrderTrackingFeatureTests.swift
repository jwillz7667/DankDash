import XCTest
import ComposableArchitecture
import DankDashDomain
import DankDashStorage
@testable import DankDashFeatures

@MainActor
final class OrderTrackingFeatureTests: XCTestCase {
  func test_onAppear_loadsDetailAndPopulatesState() async {
    let orderId = UUID()
    let detail = makeDetail(orderId: orderId, status: .placed)
    let cacheRecorder = CacheWriteRecorder()
    let clock = TestClock()

    let store = TestStore(
      initialState: OrderTrackingFeature.State(orderId: orderId)
    ) {
      OrderTrackingFeature()
    } withDependencies: {
      $0.ordersAPIClient.getOrder = { _ in detail }
      $0.orderCacheClient.readDetail = { _ in nil }
      $0.orderCacheClient.writeDetail = { cached, id in
        await cacheRecorder.record(cached: cached, orderId: id)
      }
      $0.realtimeClient.subscribe = { _ in neverEmittingStream() }
      $0.continuousClock = clock
      $0.date.now = Date(timeIntervalSinceReferenceDate: 1_000)
    }

    await store.send(.onAppear) {
      $0.isLoading = true
    }
    await store.receive(\.detailLoaded.success) {
      $0.isLoading = false
      $0.order = detail.order
      $0.events = detail.events
      $0.driver = detail.driver
    }

    let recorded = await cacheRecorder.snapshot()
    XCTAssertEqual(recorded.count, 1)
    XCTAssertEqual(recorded.first?.orderId, orderId)
    XCTAssertEqual(recorded.first?.cached.order, detail.order)

    await store.send(.onDisappear)
  }

  func test_onAppear_appliesCachedDetailFirst_thenOverwritesWithNetwork() async {
    let orderId = UUID()
    let cachedDetail = CachedOrderDetail(
      order: makeOrder(id: orderId, status: .accepted),
      events: [],
      driver: nil,
      cachedAt: Date(timeIntervalSinceReferenceDate: 500)
    )
    let networkDetail = makeDetail(orderId: orderId, status: .prepping)
    let clock = TestClock()

    let store = TestStore(
      initialState: OrderTrackingFeature.State(orderId: orderId)
    ) {
      OrderTrackingFeature()
    } withDependencies: {
      $0.ordersAPIClient.getOrder = { _ in networkDetail }
      $0.orderCacheClient.readDetail = { _ in cachedDetail }
      $0.orderCacheClient.writeDetail = { _, _ in }
      $0.realtimeClient.subscribe = { _ in neverEmittingStream() }
      $0.continuousClock = clock
      $0.date.now = Date(timeIntervalSinceReferenceDate: 1_000)
    }

    await store.send(.onAppear) {
      $0.isLoading = true
    }
    await store.receive(\.cachedDetailLoaded) {
      $0.order = cachedDetail.order
      $0.events = cachedDetail.events
      $0.driver = cachedDetail.driver
    }
    await store.receive(\.detailLoaded.success) {
      $0.isLoading = false
      $0.order = networkDetail.order
      $0.events = networkDetail.events
      $0.driver = networkDetail.driver
    }

    await store.send(.onDisappear)
  }

  func test_cachedDetailLoaded_isIgnoredAfterFreshDataArrived() async {
    let orderId = UUID()
    let fresh = makeOrder(id: orderId, status: .prepping)
    let cached = CachedOrderDetail(
      order: makeOrder(id: orderId, status: .placed),
      events: [],
      driver: nil,
      cachedAt: Date(timeIntervalSinceReferenceDate: 200)
    )

    let store = TestStore(
      initialState: OrderTrackingFeature.State(orderId: orderId, order: fresh)
    ) {
      OrderTrackingFeature()
    }

    await store.send(.cachedDetailLoaded(cached))
    // No state mutation expected — the in-memory order wins.
  }

  func test_detailLoaded_failure_surfacesErrorAndClearsLoading() async {
    let orderId = UUID()
    let clock = TestClock()
    let store = TestStore(
      initialState: OrderTrackingFeature.State(orderId: orderId, isLoading: true)
    ) {
      OrderTrackingFeature()
    } withDependencies: {
      $0.continuousClock = clock
    }

    struct StubError: LocalizedError {
      var errorDescription: String? { "Network unavailable" }
    }

    await store.send(.detailLoaded(.failure(EquatableError(StubError())))) {
      $0.isLoading = false
      $0.error = "Network unavailable"
    }
  }

  func test_realtimeStatusChanged_updatesOrderStatusAndAppendsEvent() async {
    let orderId = UUID()
    let initialOrder = makeOrder(id: orderId, status: .accepted)
    let changedAt = Date(timeIntervalSinceReferenceDate: 5_000)
    let clock = TestClock()

    let store = TestStore(
      initialState: OrderTrackingFeature.State(orderId: orderId, order: initialOrder)
    ) {
      OrderTrackingFeature()
    } withDependencies: {
      $0.continuousClock = clock
      $0.uuid = .incrementing
    }

    await store.send(
      .realtimeEventReceived(
        .statusChanged(orderId: orderId, status: .prepping, occurredAt: changedAt)
      )
    ) {
      $0.order = initialOrder.withStatus(.prepping, at: changedAt)
      $0.events.append(
        OrderEvent(
          id: UUID(uuidString: "00000000-0000-0000-0000-000000000000")!,
          orderId: initialOrder.id,
          eventType: "status_changed",
          actorUserId: nil,
          actorRole: "system",
          payload: .object(["status": .string("prepping")]),
          occurredAt: changedAt
        )
      )
    }
  }

  func test_realtimeStatusChanged_isIgnored_whenStatusSame() async {
    let orderId = UUID()
    let order = makeOrder(id: orderId, status: .prepping)

    let store = TestStore(
      initialState: OrderTrackingFeature.State(orderId: orderId, order: order)
    ) {
      OrderTrackingFeature()
    }

    await store.send(
      .realtimeEventReceived(
        .statusChanged(orderId: orderId, status: .prepping, occurredAt: Date())
      )
    )
  }

  func test_realtimeStatusChanged_isIgnored_forWrongOrderId() async {
    let orderId = UUID()
    let other = UUID()
    let order = makeOrder(id: orderId, status: .accepted)

    let store = TestStore(
      initialState: OrderTrackingFeature.State(orderId: orderId, order: order)
    ) {
      OrderTrackingFeature()
    }

    await store.send(
      .realtimeEventReceived(
        .statusChanged(orderId: other, status: .prepping, occurredAt: Date())
      )
    )
  }

  func test_realtimeDriverAssigned_setsDriver() async {
    let orderId = UUID()
    let driverProfile = DriverPublicProfile(
      id: UUID(),
      displayName: "Sam",
      avatarKey: nil,
      vehicleSummary: "Silver Honda Civic",
      maskedPhone: "(***) ***-1234"
    )
    let order = makeOrder(id: orderId, status: .driverAssigned)

    let store = TestStore(
      initialState: OrderTrackingFeature.State(orderId: orderId, order: order)
    ) {
      OrderTrackingFeature()
    }

    await store.send(
      .realtimeEventReceived(
        .driverAssigned(orderId: orderId, driver: driverProfile, occurredAt: Date())
      )
    ) {
      $0.driver = driverProfile
    }
  }

  func test_realtimeDriverLocation_updatesCoordinate() async {
    let orderId = UUID()
    let coord = Coordinate(latitude: 44.9778, longitude: -93.2650)
    let order = makeOrder(id: orderId, status: .enRouteDropoff)

    let store = TestStore(
      initialState: OrderTrackingFeature.State(orderId: orderId, order: order)
    ) {
      OrderTrackingFeature()
    }

    await store.send(
      .realtimeEventReceived(
        .driverLocation(orderId: orderId, coordinate: coord, capturedAt: Date())
      )
    ) {
      $0.driverCoordinate = coord
    }
  }

  func test_realtimeEtaUpdated_setsEtaMinutes() async {
    let orderId = UUID()
    let order = makeOrder(id: orderId, status: .enRouteDropoff)

    let store = TestStore(
      initialState: OrderTrackingFeature.State(orderId: orderId, order: order)
    ) {
      OrderTrackingFeature()
    }

    await store.send(
      .realtimeEventReceived(
        .etaUpdated(orderId: orderId, etaMinutes: 7, updatedAt: Date())
      )
    ) {
      $0.etaMinutes = 7
    }
  }

  func test_realtimeStreamFailure_startsPollingThatReFetchesEvery15s() async {
    let orderId = UUID()
    let order = makeOrder(id: orderId, status: .prepping)
    let updated = makeDetail(orderId: orderId, status: .enRouteDropoff)
    let clock = TestClock()
    let fetchRecorder = FetchCounter()

    let store = TestStore(
      initialState: OrderTrackingFeature.State(orderId: orderId, order: order)
    ) {
      OrderTrackingFeature()
    } withDependencies: {
      $0.ordersAPIClient.getOrder = { _ in
        await fetchRecorder.bump()
        return updated
      }
      $0.orderCacheClient.writeDetail = { _, _ in }
      $0.continuousClock = clock
      $0.date.now = Date(timeIntervalSinceReferenceDate: 1_000)
    }

    struct StubError: LocalizedError {
      var errorDescription: String? { "socket disconnected" }
    }

    await store.send(.realtimeStreamFailed(EquatableError(StubError()))) {
      $0.error = "socket disconnected"
      $0.isPolling = true
    }

    await clock.advance(by: .seconds(15))
    await store.receive(\.detailLoaded.success) {
      $0.isLoading = false
      $0.error = nil
      $0.order = updated.order
      $0.events = updated.events
      $0.driver = updated.driver
    }
    let firstCount = await fetchRecorder.snapshot()
    XCTAssertEqual(firstCount, 1)

    await clock.advance(by: .seconds(15))
    await store.receive(\.detailLoaded.success)
    let secondCount = await fetchRecorder.snapshot()
    XCTAssertEqual(secondCount, 2)

    await store.send(.onDisappear)
  }

  func test_realtimeEventAfterPolling_cancelsPolling() async {
    let orderId = UUID()
    let order = makeOrder(id: orderId, status: .prepping)
    let clock = TestClock()

    let store = TestStore(
      initialState: OrderTrackingFeature.State(orderId: orderId, order: order)
    ) {
      OrderTrackingFeature()
    } withDependencies: {
      $0.continuousClock = clock
    }

    struct StubError: LocalizedError {
      var errorDescription: String? { "boom" }
    }

    await store.send(.realtimeStreamFailed(EquatableError(StubError()))) {
      $0.error = "boom"
      $0.isPolling = true
    }

    await store.send(
      .realtimeEventReceived(
        .etaUpdated(orderId: orderId, etaMinutes: 4, updatedAt: Date())
      )
    ) {
      $0.etaMinutes = 4
      $0.isPolling = false
    }

    // No further polling effect should fire even after clock advances.
    await clock.advance(by: .seconds(60))
  }

  func test_repeatedRealtimeStreamFailures_doNotStackPollingEffects() async {
    let orderId = UUID()
    let order = makeOrder(id: orderId, status: .prepping)
    let updated = makeDetail(orderId: orderId, status: .enRouteDropoff)
    let clock = TestClock()
    let fetchRecorder = FetchCounter()

    let store = TestStore(
      initialState: OrderTrackingFeature.State(orderId: orderId, order: order)
    ) {
      OrderTrackingFeature()
    } withDependencies: {
      $0.ordersAPIClient.getOrder = { _ in
        await fetchRecorder.bump()
        return updated
      }
      $0.orderCacheClient.writeDetail = { _, _ in }
      $0.continuousClock = clock
      $0.date.now = Date(timeIntervalSinceReferenceDate: 1_000)
    }

    struct StubError: LocalizedError { var errorDescription: String? { "x" } }

    await store.send(.realtimeStreamFailed(EquatableError(StubError()))) {
      $0.error = "x"
      $0.isPolling = true
    }
    await store.send(.realtimeStreamFailed(EquatableError(StubError())))
    // No state change on second failure — polling already on.

    await clock.advance(by: .seconds(15))
    await store.receive(\.detailLoaded.success) {
      $0.isLoading = false
      $0.error = nil
      $0.order = updated.order
      $0.events = updated.events
      $0.driver = updated.driver
    }
    let count = await fetchRecorder.snapshot()
    XCTAssertEqual(count, 1, "polling should fire exactly one fetch per tick")

    await store.send(.onDisappear)
  }

  func test_deliveredStatus_schedulesRatingTimer_thatFiresAfter5Minutes() async {
    let orderId = UUID()
    let order = makeOrder(id: orderId, status: .enRouteDropoff)
    let clock = TestClock()

    let store = TestStore(
      initialState: OrderTrackingFeature.State(orderId: orderId, order: order)
    ) {
      OrderTrackingFeature()
    } withDependencies: {
      $0.continuousClock = clock
      $0.uuid = .incrementing
    }

    let deliveredAt = Date(timeIntervalSinceReferenceDate: 10_000)
    await store.send(
      .realtimeEventReceived(
        .statusChanged(orderId: orderId, status: .delivered, occurredAt: deliveredAt)
      )
    ) {
      $0.order = order.withStatus(.delivered, at: deliveredAt)
      $0.events.append(
        OrderEvent(
          id: UUID(uuidString: "00000000-0000-0000-0000-000000000000")!,
          orderId: order.id,
          eventType: "status_changed",
          actorUserId: nil,
          actorRole: "system",
          payload: .object(["status": .string("delivered")]),
          occurredAt: deliveredAt
        )
      )
    }

    await clock.advance(by: .seconds(300))
    await store.receive(\.ratingTimerFired) {
      $0.ratingDue = true
    }
    await store.receive(\.delegate.ratingDue)
  }

  func test_deliveredOnInitialFetch_schedulesRatingTimer() async {
    let orderId = UUID()
    let detail = makeDetail(orderId: orderId, status: .delivered)
    let clock = TestClock()

    let store = TestStore(
      initialState: OrderTrackingFeature.State(orderId: orderId)
    ) {
      OrderTrackingFeature()
    } withDependencies: {
      $0.ordersAPIClient.getOrder = { _ in detail }
      $0.orderCacheClient.readDetail = { _ in nil }
      $0.orderCacheClient.writeDetail = { _, _ in }
      $0.realtimeClient.subscribe = { _ in neverEmittingStream() }
      $0.continuousClock = clock
      $0.date.now = Date(timeIntervalSinceReferenceDate: 1_000)
    }

    await store.send(.onAppear) {
      $0.isLoading = true
    }
    await store.receive(\.detailLoaded.success) {
      $0.isLoading = false
      $0.order = detail.order
      $0.events = detail.events
      $0.driver = detail.driver
    }

    await clock.advance(by: .seconds(300))
    await store.receive(\.ratingTimerFired) {
      $0.ratingDue = true
    }
    await store.receive(\.delegate.ratingDue)

    await store.send(.onDisappear)
  }

  func test_onDisappear_cancelsRatingTimer() async {
    let orderId = UUID()
    let order = makeOrder(id: orderId, status: .enRouteDropoff)
    let clock = TestClock()

    let store = TestStore(
      initialState: OrderTrackingFeature.State(orderId: orderId, order: order)
    ) {
      OrderTrackingFeature()
    } withDependencies: {
      $0.continuousClock = clock
      $0.uuid = .incrementing
    }

    let deliveredAt = Date(timeIntervalSinceReferenceDate: 10_000)
    await store.send(
      .realtimeEventReceived(
        .statusChanged(orderId: orderId, status: .delivered, occurredAt: deliveredAt)
      )
    ) {
      $0.order = order.withStatus(.delivered, at: deliveredAt)
      $0.events.append(
        OrderEvent(
          id: UUID(uuidString: "00000000-0000-0000-0000-000000000000")!,
          orderId: order.id,
          eventType: "status_changed",
          actorUserId: nil,
          actorRole: "system",
          payload: .object(["status": .string("delivered")]),
          occurredAt: deliveredAt
        )
      )
    }

    await store.send(.onDisappear)
    // Advancing past 300s should NOT fire ratingTimerFired now that
    // onDisappear cancelled it.
    await clock.advance(by: .seconds(600))
  }

  func test_dismissRatingSheet_clearsRatingDue_andCancelsTimer() async {
    let orderId = UUID()
    let store = TestStore(
      initialState: OrderTrackingFeature.State(
        orderId: orderId,
        order: makeOrder(id: orderId, status: .delivered),
        ratingDue: true
      )
    ) {
      OrderTrackingFeature()
    }

    await store.send(.dismissRatingSheet) {
      $0.ratingDue = false
    }
  }

  func test_mapVisible_isTrueOnlyWithDriverAndNonTerminalOrder() {
    let orderId = UUID()
    var state = OrderTrackingFeature.State(orderId: orderId)
    XCTAssertFalse(state.mapVisible)

    state.order = makeOrder(id: orderId, status: .enRouteDropoff)
    XCTAssertFalse(state.mapVisible, "no driver yet")

    state.driver = DriverPublicProfile(
      id: UUID(),
      displayName: "Sam",
      avatarKey: nil,
      vehicleSummary: nil,
      maskedPhone: nil
    )
    XCTAssertTrue(state.mapVisible)

    state.order = makeOrder(id: orderId, status: .delivered)
    XCTAssertFalse(state.mapVisible, "terminal hides map")
  }

  func test_onAppear_isIdempotent_whenAlreadyLoading() async {
    let orderId = UUID()
    let store = TestStore(
      initialState: OrderTrackingFeature.State(orderId: orderId, isLoading: true)
    ) {
      OrderTrackingFeature()
    }

    await store.send(.onAppear)
  }
}

// MARK: - Helpers

private func makeOrder(id: UUID, status: OrderStatus) -> Order {
  Order(
    id: id,
    shortCode: "DD-1234",
    userId: UUID(),
    dispensaryId: UUID(),
    deliveryAddressId: UUID(),
    status: status,
    subtotalCents: 5_000,
    cannabisTaxCents: 500,
    salesTaxCents: 350,
    deliveryFeeCents: 599,
    driverTipCents: 0,
    discountCents: 0,
    totalCents: 6_449,
    items: [],
    placedAt: Date(timeIntervalSinceReferenceDate: 0),
    statusChangedAt: Date(timeIntervalSinceReferenceDate: 0),
    createdAt: Date(timeIntervalSinceReferenceDate: 0),
    updatedAt: Date(timeIntervalSinceReferenceDate: 0)
  )
}

private func makeDetail(
  orderId: UUID,
  status: OrderStatus,
  driver: DriverPublicProfile? = nil
) -> OrderDetail {
  OrderDetail(
    order: makeOrder(id: orderId, status: status),
    events: [],
    driver: driver
  )
}

private func neverEmittingStream() -> AsyncThrowingStream<RealtimeOrderEvent, Error> {
  AsyncThrowingStream { _ in
    // The continuation lives forever — the stream never yields or
    // finishes. The reducer cancels the subscription effect on
    // .onDisappear, which terminates the awaiting `for try await`.
  }
}

// MARK: - Recorders

private actor CacheWriteRecorder {
  struct Call: Equatable {
    let cached: CachedOrderDetail
    let orderId: UUID
  }

  private(set) var calls: [Call] = []

  func record(cached: CachedOrderDetail, orderId: UUID) {
    calls.append(Call(cached: cached, orderId: orderId))
  }

  func snapshot() -> [Call] { calls }
}

private actor FetchCounter {
  private(set) var count = 0

  func bump() {
    count += 1
  }

  func snapshot() -> Int { count }
}
