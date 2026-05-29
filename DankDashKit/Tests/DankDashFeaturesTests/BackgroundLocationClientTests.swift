import XCTest
import DankDashDomain
@testable import DankDashFeatures

/// The live binding wraps CoreLocation and only runs under iOS — these
/// tests cover the pure-Swift fixtures (`.unimplemented`, `.test`) and
/// the value types around the client, which is what reducers consume.
final class BackgroundLocationClientTests: XCTestCase {
  // MARK: - Unimplemented fixture

  func test_unimplementedClient_authStatusIsNotDetermined() {
    let client = BackgroundLocationClient.unimplemented
    XCTAssertEqual(client.authorizationStatus(), .notDetermined)
  }

  func test_unimplementedClient_requestAlwaysReturnsNotDetermined() async {
    let client = BackgroundLocationClient.unimplemented
    let status = await client.requestAlwaysAuthorization()
    XCTAssertEqual(status, .notDetermined)
  }

  func test_unimplementedClient_streamFinishesImmediately() async {
    let client = BackgroundLocationClient.unimplemented
    var received: [Coordinate] = []
    for await coord in client.locationUpdates() {
      received.append(coord)
    }
    XCTAssertEqual(received, [], "unimplemented stream finishes with no values")
  }

  // MARK: - Test fixture

  func test_testClient_replaysCoordinatesInOrderThenFinishes() async {
    let coords = [
      Coordinate(latitude: 44.9778, longitude: -93.2650),
      Coordinate(latitude: 44.9779, longitude: -93.2651),
      Coordinate(latitude: 44.9780, longitude: -93.2652),
    ]
    let client = BackgroundLocationClient.test(status: .authorizedAlways, coordinates: coords)
    XCTAssertEqual(client.authorizationStatus(), .authorizedAlways)
    XCTAssertTrue(client.authorizationStatus().isAuthorized)

    var received: [Coordinate] = []
    for await coord in client.locationUpdates() {
      received.append(coord)
    }
    XCTAssertEqual(received, coords)
  }

  func test_testClient_deniedAuthStatus() async {
    let client = BackgroundLocationClient.test(status: .denied)
    XCTAssertEqual(client.authorizationStatus(), .denied)
    XCTAssertFalse(client.authorizationStatus().isAuthorized)
    let granted = await client.requestAlwaysAuthorization()
    XCTAssertEqual(granted, .denied)
  }

  func test_testClient_beginAndEndUpdatesAreNoops() async {
    let client = BackgroundLocationClient.test(status: .authorizedAlways)
    await client.beginUpdates(.standard(accuracy: .balanced))
    await client.setUpdateMode(.significantChange)
    await client.endUpdates()
  }

  // MARK: - LocationAuthorizationStatus

  func test_isAuthorized_treatsAllAuthorizedVariantsAsAuthorized() {
    XCTAssertTrue(LocationAuthorizationStatus.authorized.isAuthorized)
    XCTAssertTrue(LocationAuthorizationStatus.authorizedAlways.isAuthorized)
    XCTAssertTrue(LocationAuthorizationStatus.authorizedWhenInUse.isAuthorized)
  }

  func test_isAuthorized_isFalseForNonAuthorizedCases() {
    XCTAssertFalse(LocationAuthorizationStatus.notDetermined.isAuthorized)
    XCTAssertFalse(LocationAuthorizationStatus.denied.isAuthorized)
    XCTAssertFalse(LocationAuthorizationStatus.restricted.isAuthorized)
  }

  // MARK: - LocationUpdateMode equality

  func test_locationUpdateMode_isEquatableAcrossVariants() {
    XCTAssertEqual(
      LocationUpdateMode.standard(accuracy: .balanced),
      LocationUpdateMode.standard(accuracy: .balanced)
    )
    XCTAssertNotEqual(
      LocationUpdateMode.standard(accuracy: .best),
      LocationUpdateMode.standard(accuracy: .balanced)
    )
    XCTAssertNotEqual(
      LocationUpdateMode.standard(accuracy: .best),
      LocationUpdateMode.significantChange
    )
    XCTAssertEqual(LocationUpdateMode.significantChange, LocationUpdateMode.significantChange)
  }
}
