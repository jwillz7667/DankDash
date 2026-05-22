import XCTest
@testable import DankDashDomain

/// ``Vehicle.isComplete`` is the onboarding gate. The shift home reads
/// it before allowing the toggle to flip online, so a regression that
/// declares an incomplete vehicle complete would let a driver go online
/// with a half-filled record — which the backend would reject. Cover
/// every missing-field and whitespace-only case.
final class VehicleTests: XCTestCase {
  private let fullySpecified = Vehicle(
    make: "Honda",
    model: "Civic",
    year: 2021,
    plate: "ABC123",
    color: "Blue"
  )

  func test_isComplete_allFieldsPresent_returnsTrue() {
    XCTAssertTrue(fullySpecified.isComplete)
  }

  func test_isComplete_missingMake_returnsFalse() {
    XCTAssertFalse(Vehicle(make: nil, model: "Civic", year: 2021, plate: "ABC", color: "Blue").isComplete)
  }

  func test_isComplete_missingModel_returnsFalse() {
    XCTAssertFalse(Vehicle(make: "Honda", model: nil, year: 2021, plate: "ABC", color: "Blue").isComplete)
  }

  func test_isComplete_missingYear_returnsFalse() {
    XCTAssertFalse(Vehicle(make: "Honda", model: "Civic", year: nil, plate: "ABC", color: "Blue").isComplete)
  }

  func test_isComplete_missingPlate_returnsFalse() {
    XCTAssertFalse(Vehicle(make: "Honda", model: "Civic", year: 2021, plate: nil, color: "Blue").isComplete)
  }

  func test_isComplete_missingColor_returnsFalse() {
    XCTAssertFalse(Vehicle(make: "Honda", model: "Civic", year: 2021, plate: "ABC", color: nil).isComplete)
  }

  func test_isComplete_whitespaceOnlyMake_returnsFalse() {
    XCTAssertFalse(Vehicle(make: "   ", model: "Civic", year: 2021, plate: "ABC", color: "Blue").isComplete)
  }

  func test_isComplete_whitespaceOnlyPlate_returnsFalse() {
    XCTAssertFalse(Vehicle(make: "Honda", model: "Civic", year: 2021, plate: "\t\n", color: "Blue").isComplete)
  }

  func test_isComplete_emptyDefaultInit_returnsFalse() {
    XCTAssertFalse(Vehicle().isComplete)
  }

  func test_displaySummary_includesColorYearMakeModel() {
    XCTAssertEqual(fullySpecified.displaySummary, "Blue 2021 Honda Civic")
  }

  func test_displaySummary_omitsMissingComponents() {
    let partial = Vehicle(make: "Honda", model: "Civic", year: nil, plate: nil, color: nil)
    XCTAssertEqual(partial.displaySummary, "Honda Civic")
  }

  func test_displaySummary_returnsNilForEmptyVehicle() {
    XCTAssertNil(Vehicle().displaySummary)
  }
}
