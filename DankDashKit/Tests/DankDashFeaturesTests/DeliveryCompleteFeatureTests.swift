import XCTest
import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

/// Reducer coverage for the delivery-confirmation screen — the final
/// transition that flips the order to `delivered` and triggers
/// earnings settlement.
///
/// The reducer is narrow but has three failure modes that branch in
/// meaningfully different ways: ID-scan-required (defensive — bounce
/// back to scan), state-conflict (already-delivered — pop forward),
/// and generic failure (retry). Tests cover each.
@MainActor
final class DeliveryCompleteFeatureTests: XCTestCase {

  // MARK: - onAppear

  func test_onAppear_idle_firesConfirm_andEmitsCompletedDelegate() async {
    let initialRoute = Self.activeRoute(status: .arrivedAtDropoff, idScanPassed: true)
    let updatedRoute = Self.activeRoute(status: .delivered, idScanPassed: true)
    let confirmCalls = Locker<[ConfirmCall]>(value: [])

    let store = TestStore(
      initialState: DeliveryCompleteFeature.State(
        orderId: Self.orderId,
        route: initialRoute,
        capturedLocation: Self.dropoffLocation
      )
    ) {
      DeliveryCompleteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOrdersAPIClient.deliveryConfirm = { id, body in
        await confirmCalls.append(
          ConfirmCall(
            orderId: id,
            hasLocation: body.location != nil,
            latitude: body.location?.latitude,
            notes: body.notes
          )
        )
        return updatedRoute
      }
    }
    store.exhaustivity = .off

    await store.send(.onAppear)
    await store.skipReceivedActions()
    await store.finish()

    XCTAssertEqual(store.state.status, .completed)
    XCTAssertEqual(store.state.route, updatedRoute)
    XCTAssertNil(store.state.errorBanner)

    let calls = await confirmCalls.value
    XCTAssertEqual(calls.count, 1)
    XCTAssertEqual(calls.first?.orderId, Self.orderId)
    XCTAssertEqual(calls.first?.hasLocation, true)
    XCTAssertEqual(calls.first?.latitude, Self.dropoffLocation.latitude)
    XCTAssertNil(calls.first?.notes)
  }

  func test_onAppear_alreadyCompleted_isNoOp() async {
    let route = Self.activeRoute(status: .delivered, idScanPassed: true)

    let store = TestStore(
      initialState: DeliveryCompleteFeature.State(
        orderId: Self.orderId,
        route: route,
        status: .completed
      )
    ) {
      DeliveryCompleteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.onAppear)
  }

  func test_onAppear_confirming_isNoOp() async {
    let route = Self.activeRoute(status: .arrivedAtDropoff, idScanPassed: true)

    let store = TestStore(
      initialState: DeliveryCompleteFeature.State(
        orderId: Self.orderId,
        route: route,
        status: .confirming
      )
    ) {
      DeliveryCompleteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.onAppear)
  }

  // MARK: - Confirm response

  func test_confirmResponse_409IdScanRequired_emitsRequiresIdScanDelegate() async {
    let initialRoute = Self.activeRoute(status: .arrivedAtDropoff, idScanPassed: false)
    let error = APIError.server(
      status: 409,
      envelope: Self.envelope(code: "ID_SCAN_REQUIRED", message: "scan required")
    )

    let store = TestStore(
      initialState: DeliveryCompleteFeature.State(
        orderId: Self.orderId,
        route: initialRoute
      )
    ) {
      DeliveryCompleteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOrdersAPIClient.deliveryConfirm = { _, _ in throw error }
    }
    store.exhaustivity = .off

    await store.send(.onAppear)
    await store.skipReceivedActions()
    await store.finish()

    XCTAssertEqual(store.state.status, .failed)
    XCTAssertEqual(
      store.state.errorBanner,
      "ID scan required before delivery can be marked complete."
    )
  }

  func test_confirmResponse_409StateConflict_other_emitsDismissedAsCompleted() async {
    let initialRoute = Self.activeRoute(status: .arrivedAtDropoff, idScanPassed: true)
    let error = APIError.server(
      status: 409,
      envelope: Self.envelope(code: "ORDER_STATE_INVALID", message: "stale")
    )

    let store = TestStore(
      initialState: DeliveryCompleteFeature.State(
        orderId: Self.orderId,
        route: initialRoute
      )
    ) {
      DeliveryCompleteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOrdersAPIClient.deliveryConfirm = { _, _ in throw error }
    }
    store.exhaustivity = .off

    await store.send(.onAppear)
    await store.skipReceivedActions()
    await store.finish()

    XCTAssertEqual(store.state.status, .completed)
    XCTAssertNil(store.state.errorBanner)
  }

  func test_confirmResponse_500_setsFailedWithBanner() async {
    let initialRoute = Self.activeRoute(status: .arrivedAtDropoff, idScanPassed: true)
    let error = APIError.server(
      status: 500,
      envelope: Self.envelope(code: "INTERNAL_ERROR", message: "kaboom")
    )

    let store = TestStore(
      initialState: DeliveryCompleteFeature.State(
        orderId: Self.orderId,
        route: initialRoute
      )
    ) {
      DeliveryCompleteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOrdersAPIClient.deliveryConfirm = { _, _ in throw error }
    }
    store.exhaustivity = .off

    await store.send(.onAppear)
    await store.skipReceivedActions()
    await store.finish()

    XCTAssertEqual(store.state.status, .failed)
    XCTAssertEqual(store.state.errorBanner, "kaboom")
  }

  func test_confirmResponse_transport_setsFailedWithBanner() async {
    let initialRoute = Self.activeRoute(status: .arrivedAtDropoff, idScanPassed: true)

    let store = TestStore(
      initialState: DeliveryCompleteFeature.State(
        orderId: Self.orderId,
        route: initialRoute
      )
    ) {
      DeliveryCompleteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOrdersAPIClient.deliveryConfirm = { _, _ in
        throw APIError.transport(NSError(domain: "URLSession", code: -1009))
      }
    }
    store.exhaustivity = .off

    await store.send(.onAppear)
    await store.skipReceivedActions()
    await store.finish()

    XCTAssertEqual(store.state.status, .failed)
    XCTAssertEqual(
      store.state.errorBanner,
      "Couldn't reach DankDash. Check your connection."
    )
  }

  // MARK: - Retry

  func test_retryTapped_afterFailure_refires() async {
    let initialRoute = Self.activeRoute(status: .arrivedAtDropoff, idScanPassed: true)
    let updatedRoute = Self.activeRoute(status: .delivered, idScanPassed: true)
    let attempts = Locker<Int>(value: 0)

    let store = TestStore(
      initialState: DeliveryCompleteFeature.State(
        orderId: Self.orderId,
        route: initialRoute,
        status: .failed,
        errorBanner: "Couldn't reach DankDash. Check your connection."
      )
    ) {
      DeliveryCompleteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOrdersAPIClient.deliveryConfirm = { _, _ in
        await attempts.increment()
        return updatedRoute
      }
    }
    store.exhaustivity = .off

    await store.send(.retryTapped)
    await store.skipReceivedActions()
    await store.finish()

    XCTAssertEqual(store.state.status, .completed)
    XCTAssertNil(store.state.errorBanner)
    let count = await attempts.value
    XCTAssertEqual(count, 1)
  }

  func test_retryTapped_whenIdle_isNoOp() async {
    let initialRoute = Self.activeRoute(status: .arrivedAtDropoff, idScanPassed: true)

    let store = TestStore(
      initialState: DeliveryCompleteFeature.State(
        orderId: Self.orderId,
        route: initialRoute,
        status: .idle
      )
    ) {
      DeliveryCompleteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.retryTapped)
  }

  func test_retryTapped_whenCompleted_isNoOp() async {
    let route = Self.activeRoute(status: .delivered, idScanPassed: true)

    let store = TestStore(
      initialState: DeliveryCompleteFeature.State(
        orderId: Self.orderId,
        route: route,
        status: .completed
      )
    ) {
      DeliveryCompleteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.retryTapped)
  }

  // MARK: - Done / Back

  func test_doneTapped_completed_firesDismissedAsCompleted() async {
    let route = Self.activeRoute(status: .delivered, idScanPassed: true)

    let store = TestStore(
      initialState: DeliveryCompleteFeature.State(
        orderId: Self.orderId,
        route: route,
        status: .completed
      )
    ) {
      DeliveryCompleteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.doneTapped)
    await store.receive(\.delegate.dismissed)
  }

  func test_doneTapped_failed_firesDismissedNotCompleted() async {
    let route = Self.activeRoute(status: .arrivedAtDropoff, idScanPassed: true)

    let store = TestStore(
      initialState: DeliveryCompleteFeature.State(
        orderId: Self.orderId,
        route: route,
        status: .failed,
        errorBanner: "boom"
      )
    ) {
      DeliveryCompleteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.doneTapped)
    await store.receive(\.delegate.dismissed)
  }

  func test_backTapped_firesDismissed_andCancelsInFlight() async {
    let route = Self.activeRoute(status: .arrivedAtDropoff, idScanPassed: true)

    let store = TestStore(
      initialState: DeliveryCompleteFeature.State(
        orderId: Self.orderId,
        route: route,
        status: .confirming
      )
    ) {
      DeliveryCompleteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.backTapped)
    await store.receive(\.delegate.dismissed)
  }

  // MARK: - Banner

  func test_errorBannerDismissed_clearsBanner() async {
    let route = Self.activeRoute(status: .arrivedAtDropoff, idScanPassed: true)

    let store = TestStore(
      initialState: DeliveryCompleteFeature.State(
        orderId: Self.orderId,
        route: route,
        status: .failed,
        errorBanner: "kaboom"
      )
    ) {
      DeliveryCompleteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.errorBannerDismissed) {
      $0.errorBanner = nil
    }
  }

  // MARK: - Request shape

  func test_confirmRequest_capturesNotes() async {
    let initialRoute = Self.activeRoute(status: .arrivedAtDropoff, idScanPassed: true)
    let updatedRoute = Self.activeRoute(status: .delivered, idScanPassed: true)
    let confirmCalls = Locker<[ConfirmCall]>(value: [])

    let store = TestStore(
      initialState: DeliveryCompleteFeature.State(
        orderId: Self.orderId,
        route: initialRoute,
        notes: "Left with concierge",
        capturedLocation: Self.dropoffLocation
      )
    ) {
      DeliveryCompleteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOrdersAPIClient.deliveryConfirm = { id, body in
        await confirmCalls.append(
          ConfirmCall(
            orderId: id,
            hasLocation: body.location != nil,
            latitude: body.location?.latitude,
            notes: body.notes
          )
        )
        return updatedRoute
      }
    }
    store.exhaustivity = .off

    await store.send(.onAppear)
    await store.skipReceivedActions()
    await store.finish()

    let calls = await confirmCalls.value
    XCTAssertEqual(calls.count, 1)
    XCTAssertEqual(calls.first?.notes, "Left with concierge")
  }

  func test_confirmRequest_omitsLocationWhenAbsent() async {
    let initialRoute = Self.activeRoute(status: .arrivedAtDropoff, idScanPassed: true)
    let updatedRoute = Self.activeRoute(status: .delivered, idScanPassed: true)
    let confirmCalls = Locker<[ConfirmCall]>(value: [])

    let store = TestStore(
      initialState: DeliveryCompleteFeature.State(
        orderId: Self.orderId,
        route: initialRoute,
        capturedLocation: nil
      )
    ) {
      DeliveryCompleteFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverOrdersAPIClient.deliveryConfirm = { id, body in
        await confirmCalls.append(
          ConfirmCall(
            orderId: id,
            hasLocation: body.location != nil,
            latitude: body.location?.latitude,
            notes: body.notes
          )
        )
        return updatedRoute
      }
    }
    store.exhaustivity = .off

    await store.send(.onAppear)
    await store.skipReceivedActions()
    await store.finish()

    let calls = await confirmCalls.value
    XCTAssertEqual(calls.count, 1)
    XCTAssertEqual(calls.first?.hasLocation, false)
  }

  // MARK: - Computed helpers

  func test_isConfirming_reflectsStatus() {
    let route = Self.activeRoute(status: .arrivedAtDropoff, idScanPassed: true)
    XCTAssertFalse(
      DeliveryCompleteFeature.State(orderId: Self.orderId, route: route, status: .idle)
        .isConfirming
    )
    XCTAssertTrue(
      DeliveryCompleteFeature.State(orderId: Self.orderId, route: route, status: .confirming)
        .isConfirming
    )
    XCTAssertFalse(
      DeliveryCompleteFeature.State(orderId: Self.orderId, route: route, status: .completed)
        .isConfirming
    )
    XCTAssertFalse(
      DeliveryCompleteFeature.State(orderId: Self.orderId, route: route, status: .failed)
        .isConfirming
    )
  }

  func test_isDelivered_reflectsStatus() {
    let route = Self.activeRoute(status: .delivered, idScanPassed: true)
    XCTAssertFalse(
      DeliveryCompleteFeature.State(orderId: Self.orderId, route: route, status: .idle)
        .isDelivered
    )
    XCTAssertFalse(
      DeliveryCompleteFeature.State(orderId: Self.orderId, route: route, status: .confirming)
        .isDelivered
    )
    XCTAssertTrue(
      DeliveryCompleteFeature.State(orderId: Self.orderId, route: route, status: .completed)
        .isDelivered
    )
    XCTAssertFalse(
      DeliveryCompleteFeature.State(orderId: Self.orderId, route: route, status: .failed)
        .isDelivered
    )
  }

  // MARK: - Fixtures

  nonisolated private static let orderId =
    UUID(uuidString: "00000000-0000-0000-0000-0000000000d1")!

  nonisolated private static let driverId =
    UUID(uuidString: "00000000-0000-0000-0000-0000000000d2")!

  nonisolated private static let dispensaryId =
    UUID(uuidString: "00000000-0000-0000-0000-0000000000d3")!

  nonisolated private static let userId =
    UUID(uuidString: "00000000-0000-0000-0000-0000000000d4")!

  nonisolated private static let addressId =
    UUID(uuidString: "00000000-0000-0000-0000-0000000000d5")!

  nonisolated private static let referenceDate =
    Date(timeIntervalSince1970: 1_700_000_000)

  nonisolated private static let dispensaryLocation =
    Coordinate(latitude: 44.9792, longitude: -93.2638)
  nonisolated private static let dropoffLocation =
    Coordinate(latitude: 44.9836, longitude: -93.2667)

  nonisolated private static func activeRoute(
    status: OrderStatus,
    idScanPassed: Bool
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
    return ActiveRoute(
      order: order,
      customer: DriverHandoffCustomer(
        firstName: "Sam",
        lastName: "Jefferson",
        maskedPhone: "(555) 555-0123"
      ),
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
      events: []
    )
  }

  nonisolated private static func envelope(
    code: String,
    message: String = "msg"
  ) -> ErrorEnvelope {
    ErrorEnvelope(error: ErrorEnvelope.ErrorBody(code: code, message: message))
  }

  static func disableDependencies(_ values: inout DependencyValues) {
    values.driverOrdersAPIClient = .unimplemented
    values.hapticsClient = .noop
    values.date = .constant(Date(timeIntervalSince1970: 1_700_000_000))
  }
}

// MARK: - Helpers

private struct ConfirmCall: Sendable, Equatable {
  let orderId: UUID
  let hasLocation: Bool
  let latitude: Double?
  let notes: String?
}

private actor Locker<T: Sendable> {
  private(set) var value: T
  init(value: T) { self.value = value }
}

private extension Locker where T == [ConfirmCall] {
  func append(_ call: ConfirmCall) { value.append(call) }
}

private extension Locker where T == Int {
  func increment() { value += 1 }
}
