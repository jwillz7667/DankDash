import XCTest
import ComposableArchitecture
import DankDashDomain
@testable import DankDashFeatures

@MainActor
final class OrderDetailFeatureTests: XCTestCase {
  func test_canReorder_isTrueOnlyForDeliveredOrders() {
    let orderId = UUID()

    var state = OrderDetailFeature.State(orderId: orderId)
    XCTAssertFalse(state.canReorder, "no order yet → false")

    state.tracking.order = makeOrder(id: orderId, status: .delivered)
    XCTAssertTrue(state.canReorder)

    state.tracking.order = makeOrder(id: orderId, status: .canceled)
    XCTAssertFalse(state.canReorder, "canceled is terminal but not delivered")

    state.tracking.order = makeOrder(id: orderId, status: .enRouteDropoff)
    XCTAssertFalse(state.canReorder, "in-flight orders cannot reorder")
  }

  func test_isTerminal_reflectsUnderlyingOrderStatus() {
    let orderId = UUID()

    var state = OrderDetailFeature.State(orderId: orderId)
    XCTAssertFalse(state.isTerminal, "no order → false")

    state.tracking.order = makeOrder(id: orderId, status: .delivered)
    XCTAssertTrue(state.isTerminal)

    state.tracking.order = makeOrder(id: orderId, status: .canceled)
    XCTAssertTrue(state.isTerminal)

    state.tracking.order = makeOrder(id: orderId, status: .placed)
    XCTAssertFalse(state.isTerminal)
  }

  func test_reorderTapped_onDelivered_emitsReorderRequestedDelegate() async {
    let orderId = UUID()
    var initial = OrderDetailFeature.State(orderId: orderId)
    initial.tracking.order = makeOrder(id: orderId, status: .delivered)

    let store = TestStore(initialState: initial) {
      OrderDetailFeature()
    }

    await store.send(.reorderTapped)
    await store.receive(\.delegate.reorderRequested)
  }

  func test_reorderTapped_onNonDelivered_isNoop() async {
    let orderId = UUID()
    var initial = OrderDetailFeature.State(orderId: orderId)
    initial.tracking.order = makeOrder(id: orderId, status: .enRouteDropoff)

    let store = TestStore(initialState: initial) {
      OrderDetailFeature()
    }

    await store.send(.reorderTapped)
  }

  func test_reorderTapped_onCanceled_isNoop() async {
    let orderId = UUID()
    var initial = OrderDetailFeature.State(orderId: orderId)
    initial.tracking.order = makeOrder(id: orderId, status: .canceled)

    let store = TestStore(initialState: initial) {
      OrderDetailFeature()
    }

    await store.send(.reorderTapped)
  }

  func test_orderIdSurface_matchesInitializerArgument() {
    let id = UUID()
    let state = OrderDetailFeature.State(orderId: id)
    XCTAssertEqual(state.orderId, id)
    XCTAssertEqual(state.tracking.orderId, id)
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
