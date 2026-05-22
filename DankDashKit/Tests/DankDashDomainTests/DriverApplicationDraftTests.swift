import XCTest
@testable import DankDashDomain

/// ``DriverApplicationDraft.validate()`` is the input gate for the
/// review screen's "Submit" button — and the onboarding reducer also
/// guards on it. Cover the happy path, every missing-field case, and
/// the post-fix `isReadyToSubmit` transition.
final class DriverApplicationDraftTests: XCTestCase {
  private let completeVehicle = Vehicle(
    make: "Honda",
    model: "Civic",
    year: 2021,
    plate: "ABC123",
    color: "Blue"
  )

  private func makeDocument(slot: DocumentSlot) -> DraftDocument {
    DraftDocument(
      id: UUID(),
      slot: slot,
      localFileURL: URL(fileURLWithPath: "/tmp/\(slot.rawValue).jpg"),
      mimeType: "image/jpeg",
      capturedAt: Date(timeIntervalSince1970: 0),
      sizeBytes: 1024
    )
  }

  private var fullDocumentsMap: [DocumentSlot: DraftDocument] {
    [
      .driversLicense: makeDocument(slot: .driversLicense),
      .vehicleInsurance: makeDocument(slot: .vehicleInsurance),
      .vehicleRegistration: makeDocument(slot: .vehicleRegistration),
    ]
  }

  // MARK: - Happy path

  func test_validate_returnsEmptyForCompleteDraft() {
    let draft = DriverApplicationDraft(
      vehicle: completeVehicle,
      licenseNumber: "MN-12345678",
      documents: fullDocumentsMap
    )
    XCTAssertEqual(draft.validate(), [])
    XCTAssertTrue(draft.isReadyToSubmit)
  }

  // MARK: - Missing-field cases

  func test_validate_flagsVehicleIncomplete() {
    let draft = DriverApplicationDraft(
      vehicle: Vehicle(),
      licenseNumber: "MN-12345678",
      documents: fullDocumentsMap
    )
    XCTAssertTrue(draft.validate().contains(.vehicleIncomplete))
    XCTAssertFalse(draft.isReadyToSubmit)
  }

  func test_validate_flagsMissingLicenseNumber() {
    let draft = DriverApplicationDraft(
      vehicle: completeVehicle,
      licenseNumber: "",
      documents: fullDocumentsMap
    )
    XCTAssertTrue(draft.validate().contains(.licenseNumberMissing))
  }

  func test_validate_flagsWhitespaceOnlyLicenseNumber() {
    let draft = DriverApplicationDraft(
      vehicle: completeVehicle,
      licenseNumber: "   \t\n   ",
      documents: fullDocumentsMap
    )
    XCTAssertTrue(draft.validate().contains(.licenseNumberMissing))
  }

  func test_validate_flagsEachMissingDocumentSlot() {
    let draft = DriverApplicationDraft(
      vehicle: completeVehicle,
      licenseNumber: "MN-12345678",
      documents: [:]
    )
    let issues = Set(draft.validate())
    XCTAssertTrue(issues.contains(.documentMissing(.driversLicense)))
    XCTAssertTrue(issues.contains(.documentMissing(.vehicleInsurance)))
    XCTAssertTrue(issues.contains(.documentMissing(.vehicleRegistration)))
  }

  func test_validate_flagsOnlyMissingDocumentSlot() {
    var documents = fullDocumentsMap
    documents.removeValue(forKey: .vehicleInsurance)
    let draft = DriverApplicationDraft(
      vehicle: completeVehicle,
      licenseNumber: "MN-12345678",
      documents: documents
    )
    let issues = draft.validate()
    XCTAssertEqual(issues.count, 1)
    XCTAssertTrue(issues.contains(.documentMissing(.vehicleInsurance)))
  }

  // MARK: - ValidationIssue display copy

  func test_validationIssue_displayMessageNonEmpty() {
    let issues: [DriverApplicationDraft.ValidationIssue] = [
      .vehicleIncomplete,
      .licenseNumberMissing,
      .documentMissing(.driversLicense),
      .documentMissing(.vehicleInsurance),
      .documentMissing(.vehicleRegistration),
    ]
    for issue in issues {
      XCTAssertFalse(issue.displayMessage.isEmpty, "\(issue) displayMessage empty")
    }
  }
}
