import XCTest
import Foundation
import DankDashDomain
@testable import DankDashFeatures

final class RealtimeClientTests: XCTestCase {
  // MARK: - Parser

  /// The exact `order:status_changed` payload the realtime router emits
  /// (every field from `orderStatusChangedPayloadSchema` + `envelopeId`),
  /// with a fractional-second `changedAt` like JS `Date.toISOString()`.
  /// This is the regression that proves the consumer/driver can decode the
  /// real wire shape — the prior fixtures invented `status`/`occurredAt`,
  /// which never existed on the wire, so live tracking silently decoded to
  /// nil for every transition.
  func test_parser_statusChanged_decodesRealServerPayload() throws {
    let orderId = UUID()
    let json = """
    {
      "orderId": "\(orderId.uuidString.lowercased())",
      "customerId": "\(UUID().uuidString.lowercased())",
      "dispensaryId": "\(UUID().uuidString.lowercased())",
      "driverId": "\(UUID().uuidString.lowercased())",
      "fromStatus": "prepping",
      "toStatus": "delivered",
      "changedAt": "2026-05-21T18:00:00.123Z",
      "envelopeId": "\(UUID().uuidString.lowercased())"
    }
    """.data(using: .utf8)!
    let event = RealtimeEventParser.parse(name: "order:status_changed", payload: json)
    guard case let .statusChanged(parsedOrderId, status, occurredAt) = event else {
      XCTFail("expected statusChanged got \(String(describing: event))")
      return
    }
    XCTAssertEqual(parsedOrderId, orderId)
    XCTAssertEqual(status, .delivered)
    // The fractional second must survive — the whole bug was `.iso8601`
    // rejecting `.123Z`. Assert the sub-second remainder rather than the
    // absolute epoch so the test can't drift on a hand-computed constant.
    let fraction = occurredAt.timeIntervalSince1970.truncatingRemainder(dividingBy: 1)
    XCTAssertEqual(fraction, 0.123, accuracy: 0.002)
  }

  func test_parser_statusChanged_decodesNonFractionalTimestamp() throws {
    let orderId = UUID()
    let json = """
    {
      "orderId": "\(orderId.uuidString.lowercased())",
      "customerId": "\(UUID().uuidString.lowercased())",
      "dispensaryId": "\(UUID().uuidString.lowercased())",
      "driverId": null,
      "fromStatus": "placed",
      "toStatus": "accepted",
      "changedAt": "2026-05-21T18:00:00Z"
    }
    """.data(using: .utf8)!
    let event = RealtimeEventParser.parse(name: "order:status_changed", payload: json)
    guard case let .statusChanged(_, status, _) = event else {
      XCTFail("expected statusChanged got \(String(describing: event))")
      return
    }
    XCTAssertEqual(status, .accepted)
  }

  func test_parser_statusChanged_returnsNilForUnknownStatus() {
    let orderId = UUID()
    let json = """
    {
      "orderId": "\(orderId.uuidString.lowercased())",
      "fromStatus": "prepping",
      "toStatus": "teleported",
      "changedAt": "2026-05-21T18:00:00.000Z"
    }
    """.data(using: .utf8)!
    let event = RealtimeEventParser.parse(name: "order:status_changed", payload: json)
    XCTAssertNil(event)
  }

  func test_parser_statusChanged_returnsNilForMalformedUuid() {
    let json = """
    {
      "orderId": "not-a-uuid",
      "fromStatus": "prepping",
      "toStatus": "delivered",
      "changedAt": "2026-05-21T18:00:00.000Z"
    }
    """.data(using: .utf8)!
    let event = RealtimeEventParser.parse(name: "order:status_changed", payload: json)
    XCTAssertNil(event)
  }

  func test_parser_driverAssigned_isNotAWireEvent() {
    // The server never emits `order:driver_assigned`; assignment arrives as
    // `order:status_changed` → `driver_assigned`, and OrderTracking
    // self-heals the driver profile via a detail refetch.
    let json = #"{"orderId": "x"}"#.data(using: .utf8)!
    XCTAssertNil(RealtimeEventParser.parse(name: "order:driver_assigned", payload: json))
  }

  func test_parser_driverLocation_decodesRealServerPayload() throws {
    let orderId = UUID()
    let json = """
    {
      "driverId": "\(UUID().uuidString.lowercased())",
      "orderId": "\(orderId.uuidString.lowercased())",
      "customerId": "\(UUID().uuidString.lowercased())",
      "lat": 44.9805,
      "lng": -93.2708,
      "accuracyMeters": 5.0,
      "speedMps": 8.3,
      "headingDeg": 270.0,
      "recordedAt": "2026-05-21T18:02:00.500Z",
      "envelopeId": "\(UUID().uuidString.lowercased())"
    }
    """.data(using: .utf8)!
    let event = RealtimeEventParser.parse(name: "driver:location", payload: json)
    guard case let .driverLocation(parsedOrderId, coordinate, _) = event else {
      XCTFail("expected driverLocation got \(String(describing: event))")
      return
    }
    XCTAssertEqual(parsedOrderId, orderId)
    XCTAssertEqual(coordinate.latitude, 44.9805, accuracy: 0.0001)
    XCTAssertEqual(coordinate.longitude, -93.2708, accuracy: 0.0001)
  }

  func test_parser_etaUpdated_decodesRealServerPayload() throws {
    let orderId = UUID()
    let json = """
    {
      "orderId": "\(orderId.uuidString.lowercased())",
      "customerId": "\(UUID().uuidString.lowercased())",
      "driverId": "\(UUID().uuidString.lowercased())",
      "etaSeconds": 725,
      "distanceMeters": 1800.0,
      "source": "mapbox",
      "computedAt": "2026-05-21T18:03:00.000Z"
    }
    """.data(using: .utf8)!
    let event = RealtimeEventParser.parse(name: "customer:eta_updated", payload: json)
    guard case let .etaUpdated(parsedOrderId, eta, _) = event else {
      XCTFail("expected etaUpdated got \(String(describing: event))")
      return
    }
    XCTAssertEqual(parsedOrderId, orderId)
    XCTAssertEqual(eta, 12, "725s rounds to 12 min")
  }

  func test_parser_etaUpdated_oldEventNameIsNotDecoded() {
    // The server emits `customer:eta_updated`, never `order:eta_updated`.
    let json = #"{"orderId": "x", "etaSeconds": 60, "computedAt": "2026-05-21T18:03:00Z"}"#.data(using: .utf8)!
    XCTAssertNil(RealtimeEventParser.parse(name: "order:eta_updated", payload: json))
  }

  func test_parser_unknownEventName_returnsNil() {
    let json = #"{}"#.data(using: .utf8)!
    let event = RealtimeEventParser.parse(name: "totally:made_up", payload: json)
    XCTAssertNil(event)
  }

  func test_parser_malformedJson_returnsNil() {
    let json = "{ not json".data(using: .utf8)!
    let event = RealtimeEventParser.parse(name: "order:status_changed", payload: json)
    XCTAssertNil(event)
  }

  // MARK: - Client surface

  func test_unimplemented_subscribeStreamThrows() async {
    let client = RealtimeClient.unimplemented
    let stream = await client.subscribe(UUID())
    do {
      for try await _ in stream {
        XCTFail("expected throw, not yield")
      }
      XCTFail("expected throw, stream completed normally")
    } catch let error as RealtimeClientError {
      guard case let .unimplemented(name) = error else {
        XCTFail("unexpected error: \(error)")
        return
      }
      XCTAssertEqual(name, "subscribe")
    } catch {
      XCTFail("unexpected error type: \(error)")
    }
  }

  func test_unimplemented_unsubscribeAndDisconnect_areNoOps() async {
    let client = RealtimeClient.unimplemented
    await client.unsubscribe(UUID())
    await client.disconnect()
  }

  func test_customClient_subscribeYieldsAndCompletes() async throws {
    let target = UUID()
    let event = RealtimeOrderEvent.statusChanged(
      orderId: target,
      status: .delivered,
      occurredAt: Date(timeIntervalSinceReferenceDate: 0)
    )
    let client = RealtimeClient(
      subscribe: { orderId in
        XCTAssertEqual(orderId, target)
        return AsyncThrowingStream { continuation in
          continuation.yield(event)
          continuation.finish()
        }
      },
      unsubscribe: { _ in },
      disconnect: { }
    )

    let stream = await client.subscribe(target)
    var collected: [RealtimeOrderEvent] = []
    for try await received in stream {
      collected.append(received)
    }
    XCTAssertEqual(collected, [event])
  }

  func test_realtimeClientError_isEquatable() {
    XCTAssertEqual(
      RealtimeClientError.unimplemented("subscribe"),
      RealtimeClientError.unimplemented("subscribe")
    )
    XCTAssertNotEqual(
      RealtimeClientError.unimplemented("subscribe"),
      RealtimeClientError.unimplemented("disconnect")
    )
    XCTAssertNotEqual(
      RealtimeClientError.unimplemented("subscribe"),
      RealtimeClientError.connectionFailed("boom")
    )
  }
}
