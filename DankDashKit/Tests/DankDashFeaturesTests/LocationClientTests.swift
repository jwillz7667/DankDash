import XCTest
import DankDashDomain
@testable import DankDashFeatures

final class LocationClientTests: XCTestCase {
  func test_unimplementedClient_authStatusIsNotDetermined() {
    let client = LocationClient.unimplemented
    XCTAssertEqual(client.authorizationStatus(), .notDetermined)
  }

  func test_unimplementedClient_requestAuthReturnsNotDetermined() async {
    let client = LocationClient.unimplemented
    let status = await client.requestAuthorization()
    XCTAssertEqual(status, .notDetermined)
  }

  func test_unimplementedClient_currentLocationThrows() async {
    let client = LocationClient.unimplemented
    do {
      _ = try await client.currentLocation()
      XCTFail("expected unavailable error")
    } catch let error as LocationClientError {
      XCTAssertEqual(error, .unavailable)
    } catch {
      XCTFail("unexpected error type: \(error)")
    }
  }

  func test_testClient_authorizedReturnsCoordinate() async throws {
    let coord = Coordinate(latitude: 44.95, longitude: -93.10)
    let client = LocationClient.test(status: .authorized, coordinate: coord)
    XCTAssertEqual(client.authorizationStatus(), .authorized)
    let location = try await client.currentLocation()
    XCTAssertEqual(location.latitude, 44.95, accuracy: 1e-6)
    XCTAssertEqual(location.longitude, -93.10, accuracy: 1e-6)
  }

  func test_testClient_deniedThrowsNotAuthorized() async {
    let client = LocationClient.test(status: .denied)
    do {
      _ = try await client.currentLocation()
      XCTFail("expected notAuthorized error")
    } catch let error as LocationClientError {
      XCTAssertEqual(error, .notAuthorized)
    } catch {
      XCTFail("unexpected error type: \(error)")
    }
  }
}
