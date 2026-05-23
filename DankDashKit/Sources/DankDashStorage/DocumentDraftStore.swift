import Foundation

/// Errors surfaced by ``DocumentDraftStore``. Mirrors the typed-error
/// idiom in ``OrderCache`` so callers can distinguish "not there"
/// (`nil`) from "tried and failed" (`throw`).
public enum DocumentDraftStoreError: Error, Sendable {
  case directoryCreationFailed(URL, underlying: Error)
  case writeFailed(URL, underlying: Error)
  case readFailed(URL, underlying: Error)
  case encodingFailed(underlying: Error)
  case decodingFailed(underlying: Error)
  case sourceFileMissing(URL)
}

/// On-disk metadata for a stored document. Mirrors the iOS Domain
/// ``DraftDocument`` shape but lives in Storage so the file-backed
/// persistence isn't entangled with the Domain's identity invariants.
/// `slot` is the wire-side `document_kind` discriminator
/// (`drivers_license` / `vehicle_insurance` / `vehicle_registration`)
/// — kept as a String here so the store has no compile-time dep on
/// `DocumentSlot`'s case set.
public struct StoredDocumentManifestEntry: Codable, Sendable, Equatable {
  public let documentId: UUID
  public let slot: String
  public let storedFilename: String
  public let mimeType: String
  public let capturedAt: Date
  public let sizeBytes: Int

  public init(
    documentId: UUID,
    slot: String,
    storedFilename: String,
    mimeType: String,
    capturedAt: Date,
    sizeBytes: Int
  ) {
    self.documentId = documentId
    self.slot = slot
    self.storedFilename = storedFilename
    self.mimeType = mimeType
    self.capturedAt = capturedAt
    self.sizeBytes = sizeBytes
  }
}

/// File-backed store for driver-application documents (driver's
/// license, insurance, vehicle registration). The presigned-URL upload
/// endpoint isn't built yet (Phase 19 deferred) so documents live in
/// the app's sandbox until that endpoint lands; this store is the
/// staging area in the meantime.
///
/// Layout under `<directory>/`:
///
///   <draftId>/
///     manifest.json    ← `[StoredDocumentManifestEntry]`
///     <storedFilename> ← the actual document bytes
///
/// The directory naming mirrors how a future "presigned upload"
/// integration will batch documents — one folder per draft submission
/// means we can iterate, upload, and remove with a single pass.
///
/// `@unchecked Sendable` follows the ``CatalogCache`` / ``OrderCache``
/// precedent — `FileManager` is documented thread-safe.
public struct DocumentDraftStore: @unchecked Sendable {
  public let directory: URL
  private let fileManager: FileManager
  private let encoder: JSONEncoder
  private let decoder: JSONDecoder

  /// Documents persist to Application Support, not Caches — the OS is
  /// allowed to evict Caches under disk pressure, and re-shooting a
  /// driver's license is friction worth avoiding.
  public static let defaultDirectory: URL = {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    return base.appendingPathComponent("DankDasherDrafts", isDirectory: true)
  }()

  public init(
    directory: URL = DocumentDraftStore.defaultDirectory,
    fileManager: FileManager = .default
  ) {
    self.directory = directory
    self.fileManager = fileManager
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.sortedKeys]
    self.encoder = encoder
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    self.decoder = decoder
  }

  // MARK: - Add / replace / remove

  /// Copies a freshly-picked document into the draft's folder and
  /// updates the manifest. Returns the on-disk URL so the reducer can
  /// store it on the in-memory `DraftDocument`. If a document already
  /// occupies `slot` it's replaced (rollback semantics on failure are
  /// best-effort — a half-written replacement is treated as an absent
  /// slot on the next read).
  @discardableResult
  public func saveDocument(
    draftId: UUID,
    documentId: UUID,
    slot: String,
    sourceFileURL: URL,
    mimeType: String,
    capturedAt: Date,
    sizeBytes: Int
  ) throws -> URL {
    guard fileManager.fileExists(atPath: sourceFileURL.path) else {
      throw DocumentDraftStoreError.sourceFileMissing(sourceFileURL)
    }
    let draftDir = try ensureDraftDirectory(draftId: draftId)
    let storedFilename = "\(slot)-\(documentId.uuidString.lowercased())\(Self.fileExtension(forMime: mimeType, source: sourceFileURL))"
    let destination = draftDir.appendingPathComponent(storedFilename)

    if fileManager.fileExists(atPath: destination.path) {
      try fileManager.removeItem(at: destination)
    }
    do {
      try fileManager.copyItem(at: sourceFileURL, to: destination)
    } catch {
      throw DocumentDraftStoreError.writeFailed(destination, underlying: error)
    }

    var manifest = (try? readManifest(draftId: draftId)) ?? []
    // A resubmission with a different documentId for the same slot has
    // a different stored filename than what we just wrote — make sure
    // the old file is cleaned up so we don't leak disk space across
    // re-uploads.
    for previous in manifest where previous.slot == slot && previous.storedFilename != storedFilename {
      let previousURL = draftDir.appendingPathComponent(previous.storedFilename)
      if fileManager.fileExists(atPath: previousURL.path) {
        try? fileManager.removeItem(at: previousURL)
      }
    }
    manifest.removeAll { $0.slot == slot }
    manifest.append(
      StoredDocumentManifestEntry(
        documentId: documentId,
        slot: slot,
        storedFilename: storedFilename,
        mimeType: mimeType,
        capturedAt: capturedAt,
        sizeBytes: sizeBytes
      )
    )
    try writeManifest(manifest, draftId: draftId)
    return destination
  }

  /// Removes a document and refreshes the manifest. No-ops if the slot
  /// isn't populated.
  public func removeDocument(draftId: UUID, slot: String) throws {
    var manifest = (try? readManifest(draftId: draftId)) ?? []
    guard let removed = manifest.first(where: { $0.slot == slot }) else { return }
    manifest.removeAll { $0.slot == slot }
    let fileURL = draftDirectory(draftId: draftId).appendingPathComponent(removed.storedFilename)
    if fileManager.fileExists(atPath: fileURL.path) {
      try fileManager.removeItem(at: fileURL)
    }
    try writeManifest(manifest, draftId: draftId)
  }

  // MARK: - Read

  /// Returns the manifest for `draftId` or `[]` if absent. Corrupt
  /// manifest → throws so the caller can surface a "couldn't read
  /// draft" telemetry event — a corrupt manifest is a bug, not a
  /// normal flow.
  public func readManifest(draftId: UUID) throws -> [StoredDocumentManifestEntry] {
    let url = draftDirectory(draftId: draftId).appendingPathComponent("manifest.json")
    guard fileManager.fileExists(atPath: url.path) else { return [] }
    let data: Data
    do {
      data = try Data(contentsOf: url)
    } catch {
      throw DocumentDraftStoreError.readFailed(url, underlying: error)
    }
    do {
      return try decoder.decode([StoredDocumentManifestEntry].self, from: data)
    } catch {
      throw DocumentDraftStoreError.decodingFailed(underlying: error)
    }
  }

  public func fileURL(draftId: UUID, storedFilename: String) -> URL {
    draftDirectory(draftId: draftId).appendingPathComponent(storedFilename)
  }

  // MARK: - Wipes

  /// Removes one draft's entire folder. Called after a successful
  /// presigned upload (Phase deferred) or when the user starts a fresh
  /// application.
  public func clear(draftId: UUID) throws {
    let url = draftDirectory(draftId: draftId)
    guard fileManager.fileExists(atPath: url.path) else { return }
    try fileManager.removeItem(at: url)
  }

  /// Removes every draft folder. Called on logout (different user
  /// shouldn't see the previous user's documents).
  public func clearAll() throws {
    guard fileManager.fileExists(atPath: directory.path) else { return }
    try fileManager.removeItem(at: directory)
  }

  // MARK: - Internals

  private func draftDirectory(draftId: UUID) -> URL {
    directory.appendingPathComponent(draftId.uuidString.lowercased(), isDirectory: true)
  }

  private func ensureDraftDirectory(draftId: UUID) throws -> URL {
    let url = draftDirectory(draftId: draftId)
    do {
      try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
    } catch {
      throw DocumentDraftStoreError.directoryCreationFailed(url, underlying: error)
    }
    return url
  }

  private func writeManifest(_ entries: [StoredDocumentManifestEntry], draftId: UUID) throws {
    let url = try ensureDraftDirectory(draftId: draftId).appendingPathComponent("manifest.json")
    let data: Data
    do {
      data = try encoder.encode(entries)
    } catch {
      throw DocumentDraftStoreError.encodingFailed(underlying: error)
    }
    do {
      try data.write(to: url, options: [.atomic])
    } catch {
      throw DocumentDraftStoreError.writeFailed(url, underlying: error)
    }
  }

  /// Picks a file extension based on the MIME type, falling back to
  /// the source URL's extension. We prefer the MIME-derived choice so
  /// a HEIC photo picked from Photos library ends up named `.heic` on
  /// disk regardless of the file picker's tempfile convention.
  static func fileExtension(forMime mime: String, source: URL) -> String {
    switch mime.lowercased() {
    case "image/jpeg": return ".jpg"
    case "image/png": return ".png"
    case "image/heic", "image/heif": return ".heic"
    case "application/pdf": return ".pdf"
    default:
      let sourceExt = source.pathExtension
      return sourceExt.isEmpty ? "" : "." + sourceExt
    }
  }
}
