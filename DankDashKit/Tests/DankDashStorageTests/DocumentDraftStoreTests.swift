import XCTest
@testable import DankDashStorage

/// Each test instantiates its own temp directory so parallel runs and
/// the leftover state from a failed run never bleed across tests.
final class DocumentDraftStoreTests: XCTestCase {
  private var directory: URL!
  private var store: DocumentDraftStore!

  override func setUp() {
    super.setUp()
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("DankDasherDocumentDraftTests-\(UUID().uuidString)", isDirectory: true)
    store = DocumentDraftStore(directory: directory)
  }

  override func tearDown() {
    try? FileManager.default.removeItem(at: directory)
    store = nil
    directory = nil
    super.tearDown()
  }

  // MARK: - Save + manifest round-trip

  func test_saveDocument_copiesBytesIntoDraftFolderAndUpdatesManifest() throws {
    let draftId = UUID()
    let documentId = UUID()
    let source = try makeSourceFile(bytes: 1_024, ext: "jpg")

    let stored = try store.saveDocument(
      draftId: draftId,
      documentId: documentId,
      slot: "drivers_license",
      sourceFileURL: source,
      mimeType: "image/jpeg",
      capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
      sizeBytes: 1_024
    )

    XCTAssertTrue(FileManager.default.fileExists(atPath: stored.path), "destination file should exist")
    XCTAssertEqual(try Data(contentsOf: stored).count, 1_024)

    let manifest = try store.readManifest(draftId: draftId)
    XCTAssertEqual(manifest.count, 1)
    let entry = try XCTUnwrap(manifest.first)
    XCTAssertEqual(entry.documentId, documentId)
    XCTAssertEqual(entry.slot, "drivers_license")
    XCTAssertEqual(entry.mimeType, "image/jpeg")
    XCTAssertEqual(entry.sizeBytes, 1_024)
    XCTAssertTrue(entry.storedFilename.hasSuffix(".jpg"))
  }

  func test_saveDocument_replacesPreviousFileWhenSameSlotIsResubmitted() throws {
    let draftId = UUID()
    let firstSource = try makeSourceFile(bytes: 512, ext: "jpg")
    let firstId = UUID()
    let firstStored = try store.saveDocument(
      draftId: draftId,
      documentId: firstId,
      slot: "drivers_license",
      sourceFileURL: firstSource,
      mimeType: "image/jpeg",
      capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
      sizeBytes: 512
    )

    let secondSource = try makeSourceFile(bytes: 2_048, ext: "png")
    let secondId = UUID()
    let secondStored = try store.saveDocument(
      draftId: draftId,
      documentId: secondId,
      slot: "drivers_license",
      sourceFileURL: secondSource,
      mimeType: "image/png",
      capturedAt: Date(timeIntervalSince1970: 1_700_000_100),
      sizeBytes: 2_048
    )

    XCTAssertNotEqual(firstStored, secondStored, "different documentId → different storedFilename")
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: firstStored.path),
      "previous slot file should be gone after replacement"
    )
    XCTAssertTrue(FileManager.default.fileExists(atPath: secondStored.path))

    let manifest = try store.readManifest(draftId: draftId)
    XCTAssertEqual(manifest.count, 1, "only one entry per slot")
    XCTAssertEqual(manifest.first?.documentId, secondId)
    XCTAssertEqual(manifest.first?.mimeType, "image/png")
  }

  func test_saveDocument_keepsManifestEntriesForOtherSlotsIntact() throws {
    let draftId = UUID()
    let licenseSource = try makeSourceFile(bytes: 256, ext: "jpg")
    let insuranceSource = try makeSourceFile(bytes: 128, ext: "pdf")
    try store.saveDocument(
      draftId: draftId,
      documentId: UUID(),
      slot: "drivers_license",
      sourceFileURL: licenseSource,
      mimeType: "image/jpeg",
      capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
      sizeBytes: 256
    )
    try store.saveDocument(
      draftId: draftId,
      documentId: UUID(),
      slot: "vehicle_insurance",
      sourceFileURL: insuranceSource,
      mimeType: "application/pdf",
      capturedAt: Date(timeIntervalSince1970: 1_700_000_100),
      sizeBytes: 128
    )

    let manifest = try store.readManifest(draftId: draftId)
    XCTAssertEqual(Set(manifest.map(\.slot)), ["drivers_license", "vehicle_insurance"])
  }

  func test_saveDocument_throwsWhenSourceMissing() {
    let missing = FileManager.default.temporaryDirectory
      .appendingPathComponent("missing-\(UUID().uuidString).jpg")
    XCTAssertThrowsError(
      try store.saveDocument(
        draftId: UUID(),
        documentId: UUID(),
        slot: "drivers_license",
        sourceFileURL: missing,
        mimeType: "image/jpeg",
        capturedAt: Date(),
        sizeBytes: 0
      )
    ) { error in
      guard case DocumentDraftStoreError.sourceFileMissing = error else {
        return XCTFail("Expected .sourceFileMissing, got \(error)")
      }
    }
  }

  // MARK: - Remove

  func test_removeDocument_clearsFileAndManifestEntry() throws {
    let draftId = UUID()
    let source = try makeSourceFile(bytes: 32, ext: "jpg")
    let stored = try store.saveDocument(
      draftId: draftId,
      documentId: UUID(),
      slot: "drivers_license",
      sourceFileURL: source,
      mimeType: "image/jpeg",
      capturedAt: Date(),
      sizeBytes: 32
    )
    XCTAssertTrue(FileManager.default.fileExists(atPath: stored.path))

    try store.removeDocument(draftId: draftId, slot: "drivers_license")
    XCTAssertFalse(FileManager.default.fileExists(atPath: stored.path))
    XCTAssertEqual(try store.readManifest(draftId: draftId), [])
  }

  func test_removeDocument_isNoopForUnknownSlot() {
    XCTAssertNoThrow(try store.removeDocument(draftId: UUID(), slot: "drivers_license"))
  }

  // MARK: - Manifest

  func test_readManifest_returnsEmptyArrayWhenDraftAbsent() throws {
    XCTAssertEqual(try store.readManifest(draftId: UUID()), [])
  }

  func test_readManifest_throwsDecodingFailedWhenManifestIsCorrupt() throws {
    let draftId = UUID()
    let draftDir = directory.appendingPathComponent(draftId.uuidString.lowercased(), isDirectory: true)
    try FileManager.default.createDirectory(at: draftDir, withIntermediateDirectories: true)
    try Data("{ not valid json".utf8).write(to: draftDir.appendingPathComponent("manifest.json"))

    XCTAssertThrowsError(try store.readManifest(draftId: draftId)) { error in
      guard case DocumentDraftStoreError.decodingFailed = error else {
        return XCTFail("Expected .decodingFailed, got \(error)")
      }
    }
  }

  // MARK: - Isolation

  func test_drafts_areIsolatedBetweenIds() throws {
    let draftA = UUID()
    let draftB = UUID()
    try store.saveDocument(
      draftId: draftA,
      documentId: UUID(),
      slot: "drivers_license",
      sourceFileURL: try makeSourceFile(bytes: 16, ext: "jpg"),
      mimeType: "image/jpeg",
      capturedAt: Date(),
      sizeBytes: 16
    )

    XCTAssertEqual(try store.readManifest(draftId: draftA).count, 1)
    XCTAssertEqual(try store.readManifest(draftId: draftB).count, 0)
  }

  // MARK: - Clear

  func test_clearDraft_removesFolderAndOthersSurvive() throws {
    let draftA = UUID()
    let draftB = UUID()
    try store.saveDocument(
      draftId: draftA,
      documentId: UUID(),
      slot: "drivers_license",
      sourceFileURL: try makeSourceFile(bytes: 16, ext: "jpg"),
      mimeType: "image/jpeg",
      capturedAt: Date(),
      sizeBytes: 16
    )
    try store.saveDocument(
      draftId: draftB,
      documentId: UUID(),
      slot: "drivers_license",
      sourceFileURL: try makeSourceFile(bytes: 16, ext: "jpg"),
      mimeType: "image/jpeg",
      capturedAt: Date(),
      sizeBytes: 16
    )

    try store.clear(draftId: draftA)

    XCTAssertEqual(try store.readManifest(draftId: draftA), [])
    XCTAssertEqual(try store.readManifest(draftId: draftB).count, 1)
  }

  func test_clearDraft_isIdempotent() {
    XCTAssertNoThrow(try store.clear(draftId: UUID()))
  }

  func test_clearAll_removesEveryDraftFolder() throws {
    try store.saveDocument(
      draftId: UUID(),
      documentId: UUID(),
      slot: "drivers_license",
      sourceFileURL: try makeSourceFile(bytes: 16, ext: "jpg"),
      mimeType: "image/jpeg",
      capturedAt: Date(),
      sizeBytes: 16
    )
    try store.saveDocument(
      draftId: UUID(),
      documentId: UUID(),
      slot: "vehicle_insurance",
      sourceFileURL: try makeSourceFile(bytes: 16, ext: "pdf"),
      mimeType: "application/pdf",
      capturedAt: Date(),
      sizeBytes: 16
    )

    try store.clearAll()

    XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
  }

  func test_clearAll_isIdempotentWhenDirectoryAbsent() {
    XCTAssertNoThrow(try store.clearAll())
    XCTAssertNoThrow(try store.clearAll())
  }

  // MARK: - MIME → extension

  func test_fileExtension_picksByMimeWhenRecognized() {
    XCTAssertEqual(
      DocumentDraftStore.fileExtension(forMime: "image/jpeg", source: URL(fileURLWithPath: "/tmp/x.bin")),
      ".jpg"
    )
    XCTAssertEqual(
      DocumentDraftStore.fileExtension(forMime: "image/png", source: URL(fileURLWithPath: "/tmp/x.bin")),
      ".png"
    )
    XCTAssertEqual(
      DocumentDraftStore.fileExtension(forMime: "image/heic", source: URL(fileURLWithPath: "/tmp/x.bin")),
      ".heic"
    )
    XCTAssertEqual(
      DocumentDraftStore.fileExtension(forMime: "image/heif", source: URL(fileURLWithPath: "/tmp/x.bin")),
      ".heic"
    )
    XCTAssertEqual(
      DocumentDraftStore.fileExtension(forMime: "application/pdf", source: URL(fileURLWithPath: "/tmp/x.bin")),
      ".pdf"
    )
  }

  func test_fileExtension_fallsBackToSourceWhenMimeUnknown() {
    XCTAssertEqual(
      DocumentDraftStore.fileExtension(forMime: "application/octet-stream", source: URL(fileURLWithPath: "/tmp/x.heic")),
      ".heic"
    )
    XCTAssertEqual(
      DocumentDraftStore.fileExtension(forMime: "application/octet-stream", source: URL(fileURLWithPath: "/tmp/blob")),
      ""
    )
  }

  // MARK: - Helpers

  private func makeSourceFile(bytes: Int, ext: String) throws -> URL {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("source-\(UUID().uuidString).\(ext)")
    let data = Data(repeating: 0xAB, count: bytes)
    try data.write(to: url)
    return url
  }
}
