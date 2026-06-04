import XCTest
import Foundation
import DankDashDomain
@testable import DankDashFeatures

final class RealtimeClientTests: XCTestCase {
  // MARK: - Parser

  func test_parser_statusChanged_decodesValidPayload() throws {
    let orderId = UUID()
    let json = """
    {
      "orderId": "\(orderId.uuidString.lowercased())",
      "status": "delivered",
      "occurredAt": "2026-05-21T18:00:00Z"
    }
    """.data(using: .utf8)!
    let event = RealtimeEventParser.parse(name: "order:status_changed", payload: json)
    guard case let .statusChanged(parsedOrderId, status, _) = event else {
      XCTFail("expected statusChanged got \(String(describing: event))")
      return
    }
    XCTAssertEqual(parsedOrderId, orderId)
    XCTAssertEqual(status, .delivered)
  }

  func test_parser_statusChanged_returnsNilForUnknownStatus() {
    let orderId = UUID()
    let json = """
    {
      "orderId": "\(orderId.uuidString.lowercased())",
      "status": "teleported",
      "occurredAt": "2026-05-21T18:00:00Z"
    }
    """.data(using: .utf8)!
    let event = RealtimeEventParser.parse(name: "order:status_changed", payload: json)
    XCTAssertNil(event)
  }

  func test_parser_statusChanged_returnsNilForMalformedUuid() {
    let json = """
    {
      "orderId": "not-a-uuid",
      "status": "delivered",
      "occurredAt": "2026-05-21T18:00:00Z"
    }
    """.data(using: .utf8)!
    let event = RealtimeEventParser.parse(name: "order:status_changed", payload: json)
    XCTAssertNil(event)
  }

  func test_parser_driverAssigned_decodesValidPayload() throws {
    let orderId = UUID()
    let driverId = UUID()
    let json = """
    {
      "orderId": "\(orderId.uuidString.lowercased())",
      "driver": {
        "id": "\(driverId.uuidString.lowercased())",
        "displayName": "Sam Driver",
        "avatarKey": null,
        "vehicleSummary": "Blue 2021 Honda Civic",
        "maskedPhone": "+1 ••• ••• 1234"
      },
      "occurredAt": "2026-05-21T18:01:00Z"
    }
    """.data(using: .utf8)!
    let event = RealtimeEventParser.parse(name: "order:driver_assigned", payload: json)
    guard case let .driverAssigned(parsedOrderId, driver, _) = event else {
      XCTFail("expected driverAssigned got \(String(describing: event))")
      return
    }
    XCTAssertEqual(parsedOrderId, orderId)
    XCTAssertEqual(driver.id, driverId)
    XCTAssertEqual(driver.displayName, "Sam Driver")
    XCTAssertEqual(driver.vehicleSummary, "Blue 2021 Honda Civic")
    XCTAssertEqual(driver.maskedPhone, "+1 ••• ••• 1234")
    XCTAssertNil(driver.avatarKey)
  }

  func test_parser_driverLocation_decodesValidPayload() throws {
    let orderId = UUID()
    let json = """
    {
      "orderId": "\(orderId.uuidString.lowercased())",
      "latitude": 44.9805,
      "longitude": -93.2708,
      "capturedAt": "2026-05-21T18:02:00Z"
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

  func test_parser_etaUpdated_decodesValidPayload() throws {
    let orderId = UUID()
    let json = """
    {
      "orderId": "\(orderId.uuidString.lowercased())",
      "etaMinutes": 12,
      "updatedAt": "2026-05-21T18:03:00Z"
    }
    """.data(using: .utf8)!
    let event = RealtimeEventParser.parse(name: "order:eta_updated", payload: json)
    guard case let .etaUpdated(parsedOrderId, eta, _) = event else {
      XCTFail("expected etaUpdated got \(String(describing: event))")
      return
    }
    XCTAssertEqual(parsedOrderId, orderId)
    XCTAssertEqual(eta, 12)
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
