import XCTest
import DankDashDomain
@testable import DankDashStorage

/// Each test owns its temp directory so parallel runs never collide.
/// The draft store is single-tenant on disk (one `active-draft.json`)
/// so isolation by directory is sufficient.
final class DriverApplicationDraftStoreTests: XCTestCase {
  private var directory: URL!
  private var store: DriverApplicationDraftStore!

  override func setUp() {
    super.setUp()
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("DankDasherApplicationDraftTests-\(UUID().uuidString)", isDirectory: true)
    store = DriverApplicationDraftStore(directory: directory)
  }

  override func tearDown() {
    try? FileManager.default.removeItem(at: directory)
    store = nil
    directory = nil
    super.tearDown()
  }

  // MARK: - Round-trip

  func test_writeDraft_thenRead_returnsExactlyWhatWasWritten() throws {
    let draft = Self.completeDraft()
    try store.write(draft)

    let read = try XCTUnwrap(store.read())
    XCTAssertEqual(read.id, draft.id)
    XCTAssertEqual(read.vehicle, draft.vehicle)
    XCTAssertEqual(read.licenseNumber, draft.licenseNumber)
    XCTAssertEqual(read.documents.keys.sorted(by: { $0.rawValue < $1.rawValue }),
                   draft.documents.keys.sorted(by: { $0.rawValue < $1.rawValue }))
    XCTAssertEqual(read.documents[.driversLicense]?.id, draft.documents[.driversLicense]?.id)
  }

  func test_read_returnsNilWhenAbsent() {
    XCTAssertNil(store.read())
  }

  func test_write_overwritesPrevious() throws {
    let first = Self.completeDraft()
    var second = first
    second.licenseNumber = "MN-99999999"
    second.updatedAt = first.updatedAt.addingTimeInterval(60)

    try store.write(first)
    try store.write(second)

    XCTAssertEqual(store.read()?.licenseNumber, "MN-99999999")
  }

  func test_writeWithIncompleteDraft_roundtripsValidationIssues() throws {
    let draft = DriverApplicationDraft()
    try store.write(draft)

    let read = try XCTUnwrap(store.read())
    XCTAssertEqual(read.id, draft.id)
    XCTAssertFalse(read.isReadyToSubmit)
    XCTAssertFalse(read.validate().isEmpty)
  }

  // MARK: - Corrupt payload

  func test_read_returnsNilWhenFileIsNotValidJSON() throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let fileURL = directory.appendingPathComponent("active-draft.json")
    try Data("{ not valid json".utf8).write(to: fileURL)

    XCTAssertNil(store.read(), "corrupt draft is treated as absent — onboarding restarts at step 1")
  }

  // MARK: - Clear

  func test_clear_removesDraft() throws {
    try store.write(Self.completeDraft())
    try store.clear()
    XCTAssertNil(store.read())
  }

  func test_clear_isIdempotent() {
    XCTAssertNoThrow(try store.clear())
    XCTAssertNoThrow(try store.clear())
  }

  func test_clearAll_removesEntireDirectory() throws {
    try store.write(Self.completeDraft())
    XCTAssertTrue(FileManager.default.fileExists(atPath: directory.path))

    try store.clearAll()
    XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
  }

  func test_clearAll_isIdempotentWhenDirectoryAbsent() {
    XCTAssertNoThrow(try store.clearAll())
    XCTAssertNoThrow(try store.clearAll())
  }

  // MARK: - Fixtures

  private static func completeDraft() -> DriverApplicationDraft {
    let vehicle = Vehicle(
      make: "Honda",
      model: "Civic",
      year: 2021,
      plate: "ABC123",
      color: "Blue"
    )
    var documents: [DocumentSlot: DraftDocument] = [:]
    for slot in DocumentSlot.allCases {
      documents[slot] = DraftDocument(
        id: UUID(),
        slot: slot,
        localFileURL: URL(fileURLWithPath: "/tmp/\(slot.rawValue).jpg"),
        mimeType: "image/jpeg",
        capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
        sizeBytes: 2_048
      )
    }
    return DriverApplicationDraft(
      vehicle: vehicle,
      licenseNumber: "MN-12345678",
      documents: documents,
      createdAt: Date(timeIntervalSince1970: 1_700_000_000),
      updatedAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
  }
}
