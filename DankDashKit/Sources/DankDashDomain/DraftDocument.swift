import Foundation

/// One document a driver has uploaded during onboarding, persisted to
/// the app's sandbox by ``DocumentDraftStore`` until the backend
/// presigned-URL endpoint lands and consumes them.
///
/// `localFileURL` is the on-disk path inside the app container; the
/// store guarantees it survives across launches but not across app
/// reinstalls. `sizeBytes` is captured at pick time so the review
/// screen can render "2.4 MB" without re-reading the file.
public struct DraftDocument: Identifiable, Hashable, Sendable, Codable {
  public let id: UUID
  public let slot: DocumentSlot
  public let localFileURL: URL
  public let mimeType: String
  public let capturedAt: Date
  public let sizeBytes: Int

  public init(
    id: UUID,
    slot: DocumentSlot,
    localFileURL: URL,
    mimeType: String,
    capturedAt: Date,
    sizeBytes: Int
  ) {
    self.id = id
    self.slot = slot
    self.localFileURL = localFileURL
    self.mimeType = mimeType
    self.capturedAt = capturedAt
    self.sizeBytes = sizeBytes
  }

  /// Human-readable size for the review row ("2.4 MB" / "812 KB").
  public var displaySize: String {
    let formatter = ByteCountFormatter()
    formatter.allowedUnits = [.useKB, .useMB]
    formatter.countStyle = .file
    return formatter.string(fromByteCount: Int64(sizeBytes))
  }
}
