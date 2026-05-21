import XCTest
import DankDashDomain
@testable import DankDashNetwork

/// Endpoint-shape pinning for the driver-app HTTP surface — path
/// templating, query composition, auth flags, encoded request bodies.
/// The DTO decoding tests cover wire-side decoding; this file covers
/// outbound shape so a rename or path drift surfaces here, not at
/// runtime.
final class DriverEndpointsTests: XCTestCase {
  private let encoder = JSONEncoder()

  // MARK: - Shift

  func test_shiftStart_postsToShiftStart() throws {
    let body = StartShiftRequestDTO(
      startingLocation: Coordinate(latitude: 44.9778, longitude: -93.2650)
    )
    let endpoint = DriverShiftEndpoints.startShift(body: body)
    XCTAssertEqual(endpoint.method, .POST)
    XCTAssertEqual(endpoint.path, "v1/driver/shift/start")
    XCTAssertTrue(endpoint.requiresAuth)
    let payload = try XCTUnwrap(endpoint.body).encode(using: encoder)
    XCTAssertFalse(payload.isEmpty)
  }

  func test_shiftEnd_postsToShiftEnd() {
    let body = EndShiftRequestDTO(
      endingLocation: Coordinate(latitude: 44.9778, longitude: -93.2650)
    )
    let endpoint = DriverShiftEndpoints.endShift(body: body)
    XCTAssertEqual(endpoint.method, .POST)
    XCTAssertEqual(endpoint.path, "v1/driver/shift/end")
    XCTAssertTrue(endpoint.requiresAuth)
  }

  func test_statusUpdate_postsStatusBody() throws {
    let body = UpdateDriverStatusRequestDTO(status: .onBreak)
    let endpoint = DriverShiftEndpoints.updateStatus(body: body)
    XCTAssertEqual(endpoint.method, .POST)
    XCTAssertEqual(endpoint.path, "v1/driver/status")
    let data = try XCTUnwrap(endpoint.body).encode(using: encoder)
    let payload = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: String])
    XCTAssertEqual(payload["status"], "on_break")
  }

  // MARK: - App read surface

  func test_me_getsDriverMe() {
    let endpoint = DriverAppEndpoints.getMe()
    XCTAssertEqual(endpoint.method, .GET)
    XCTAssertEqual(endpoint.path, "v1/driver/me")
    XCTAssertTrue(endpoint.requiresAuth)
    XCTAssertNil(endpoint.body)
  }

  func test_currentRoute_getsCurrentRoute() {
    let endpoint = DriverAppEndpoints.getCurrentRoute()
    XCTAssertEqual(endpoint.method, .GET)
    XCTAssertEqual(endpoint.path, "v1/driver/current-route")
  }

  func test_earnings_attachesPeriodQueryItem() {
    let today = DriverAppEndpoints.getEarnings(period: .today)
    XCTAssertEqual(today.path, "v1/driver/earnings")
    XCTAssertEqual(today.queryItems.first?.name, "period")
    XCTAssertEqual(today.queryItems.first?.value, "today")

    let week = DriverAppEndpoints.getEarnings(period: .week)
    XCTAssertEqual(week.queryItems.first?.value, "week")

    let month = DriverAppEndpoints.getEarnings(period: .month)
    XCTAssertEqual(month.queryItems.first?.value, "month")
  }

  func test_shifts_getsShifts() {
    let endpoint = DriverAppEndpoints.getShifts()
    XCTAssertEqual(endpoint.method, .GET)
    XCTAssertEqual(endpoint.path, "v1/driver/shifts")
  }

  // MARK: - Heatmap

  func test_heatmap_attachesCoordinateAndRadiusQueryItems() {
    let endpoint = DriverHeatmapEndpoints.getHeatmap(
      near: Coordinate(latitude: 44.9778, longitude: -93.2650)
    )
    XCTAssertEqual(endpoint.method, .GET)
    XCTAssertEqual(endpoint.path, "v1/driver/heatmap")
    let values = Dictionary(
      uniqueKeysWithValues: endpoint.queryItems.map { ($0.name, $0.value) }
    )
    XCTAssertEqual(values["lat"], "44.9778")
    XCTAssertEqual(values["lng"], "-93.265")
    XCTAssertEqual(values["radius"], "8000", "default radius is ~5 miles in meters")
  }

  func test_heatmap_acceptsCustomRadius() {
    let endpoint = DriverHeatmapEndpoints.getHeatmap(
      near: Coordinate(latitude: 44.9778, longitude: -93.2650),
      radiusMeters: 4000
    )
    let radius = endpoint.queryItems.first { $0.name == "radius" }?.value
    XCTAssertEqual(radius, "4000")
  }

  // MARK: - Offers

  func test_acceptOffer_templatesId() {
    let id = UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0B00")!
    let endpoint = DriverOffersEndpoints.acceptOffer(id: id)
    XCTAssertEqual(endpoint.method, .POST)
    XCTAssertEqual(
      endpoint.path,
      "v1/driver/offers/0190b7a4-9c00-72f5-a6b0-1c6f77ce0b00/accept"
    )
    XCTAssertNil(endpoint.body)
  }

  func test_declineOffer_templatesIdAndCarriesReasonBody() throws {
    let id = UUID(uuidString: "0190B7A4-9C00-72F5-A6B0-1C6F77CE0B00")!
    let body = DeclineOfferRequestDTO(reason: "Too far")
    let endpoint = DriverOffersEndpoints.declineOffer(id: id, body: body)
    XCTAssertEqual(endpoint.method, .POST)
    XCTAssertEqual(
      endpoint.path,
      "v1/driver/offers/0190b7a4-9c00-72f5-a6b0-1c6f77ce0b00/decline"
    )
    let data = try XCTUnwrap(endpoint.body).encode(using: encoder)
    let payload = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: String])
    XCTAssertEqual(payload["reason"], "Too far")
  }

  // MARK: - Onboarding

  func test_submitApplication_postsToApplications() throws {
    let body = DriverApplicationRequestDTO(
      vehicleMake: "Honda",
      vehicleModel: "Civic",
      vehicleYear: 2021,
      vehiclePlate: "ABC123",
      vehicleColor: "Blue",
      licenseNumber: "MN-12345678",
      documents: []
    )
    let endpoint = DriverOnboardingEndpoints.submitApplication(body: body)
    XCTAssertEqual(endpoint.method, .POST)
    XCTAssertEqual(endpoint.path, "v1/driver/applications")
    XCTAssertTrue(endpoint.requiresAuth)
    XCTAssertNotNil(endpoint.body)
  }
}
