import XCTest
@testable import DankDashDomain

/// ``DocumentSlot`` raw values become the server-side `document_kind`
/// column when the presigned-URL upload endpoint lands. Pinning them
/// keeps the rename surface tight.
final class DocumentSlotTests: XCTestCase {
  func test_rawValuesMatchWire() {
    XCTAssertEqual(DocumentSlot.driversLicense.rawValue, "drivers_license")
    XCTAssertEqual(DocumentSlot.vehicleInsurance.rawValue, "vehicle_insurance")
    XCTAssertEqual(DocumentSlot.vehicleRegistration.rawValue, "vehicle_registration")
  }

  func test_allCasesCountIsThree() {
    XCTAssertEqual(DocumentSlot.allCases.count, 3)
  }

  func test_displayLabelNonEmptyForEveryCase() {
    for slot in DocumentSlot.allCases {
      XCTAssertFalse(slot.displayLabel.isEmpty, "\(slot) displayLabel empty")
    }
  }

  func test_helperTextNonEmptyForEveryCase() {
    for slot in DocumentSlot.allCases {
      XCTAssertFalse(slot.helperText.isEmpty, "\(slot) helperText empty")
    }
  }
}
