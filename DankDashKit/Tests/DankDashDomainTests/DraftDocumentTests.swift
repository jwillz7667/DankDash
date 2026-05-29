import XCTest
@testable import DankDashDomain

final class DraftDocumentTests: XCTestCase {
  private func makeDocument(sizeBytes: Int) -> DraftDocument {
    DraftDocument(
      id: UUID(),
      slot: .driversLicense,
      localFileURL: URL(fileURLWithPath: "/tmp/test.jpg"),
      mimeType: "image/jpeg",
      capturedAt: Date(timeIntervalSince1970: 0),
      sizeBytes: sizeBytes
    )
  }

  func test_displaySize_formatsKilobytes() {
    // 812 KB on the wire — ByteCountFormatter's "useKB" picks the
    // appropriate unit for the value range.
    XCTAssertFalse(makeDocument(sizeBytes: 812 * 1024).displaySize.isEmpty)
  }

  func test_displaySize_formatsMegabytes() {
    XCTAssertFalse(makeDocument(sizeBytes: 2 * 1024 * 1024).displaySize.isEmpty)
  }

  func test_displaySize_handlesZeroBytes() {
    XCTAssertFalse(makeDocument(sizeBytes: 0).displaySize.isEmpty)
  }
}
