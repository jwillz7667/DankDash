import Foundation
import DankDashDomain

/// Errors surfaced by ``DriverApplicationDraftStore``. Mirrors the
/// typed-error idiom in ``OrderCache`` / ``DocumentDraftStore``.
public enum DriverApplicationDraftStoreError: Error, Sendable {
  case directoryCreationFailed(URL, underlying: Error)
  case writeFailed(URL, underlying: Error)
  case readFailed(URL, underlying: Error)
  case encodingFailed(underlying: Error)
  case decodingFailed(underlying: Error)
}

/// File-backed JSON store for the in-progress driver application
/// draft (vehicle details + license number + document references).
/// The reducer persists the draft on every step so a sign-out / kill
/// cycle doesn't lose the user's progress, and the pending-review
/// screen reads the saved draft on cold start to know what was
/// submitted.
///
/// Layout: `<directory>/active-draft.json` — single-tenant on a given
/// device. If the spec ever supports multiple concurrent applications
/// per user the layout grows a `<draftId>.json` shard.
///
/// `@unchecked Sendable` follows the precedent.
public struct DriverApplicationDraftStore: @unchecked Sendable {
  public let directory: URL
  private let fileManager: FileManager
  private let encoder: JSONEncoder
  private let decoder: JSONDecoder
  private let activeDraftFilename = "active-draft.json"

  /// Drafts live next to the documents in Application Support — same
  /// rationale (Caches gets evicted under disk pressure; we don't
  /// want to lose the partial draft).
  public static let defaultDirectory: URL = {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    return base.appendingPathComponent("DankDasherApplicationDrafts", isDirectory: true)
  }()

  public init(
    directory: URL = DriverApplicationDraftStore.defaultDirectory,
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

  /// Returns the active draft or nil if none. Corrupt → nil rather
  /// than throw — a corrupt draft would just make the onboarding
  /// reducer reset the user to step 1 (welcome), which is the
  /// safer-than-crash failure mode for a multi-screen flow.
  public func read() -> DriverApplicationDraft? {
    let url = directory.appendingPathComponent(activeDraftFilename)
    guard fileManager.fileExists(atPath: url.path) else { return nil }
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? decoder.decode(DriverApplicationDraft.self, from: data)
  }

  /// Writes the draft atomically. The reducer calls this on every
  /// step transition (vehicle saved, document uploaded, license
  /// entered) so a launch-and-leave doesn't lose work.
  public func write(_ draft: DriverApplicationDraft) throws {
    try ensureDirectory()
    let url = directory.appendingPathComponent(activeDraftFilename)
    let data: Data
    do {
      data = try encoder.encode(draft)
    } catch {
      throw DriverApplicationDraftStoreError.encodingFailed(underlying: error)
    }
    do {
      try data.write(to: url, options: [.atomic])
    } catch {
      throw DriverApplicationDraftStoreError.writeFailed(url, underlying: error)
    }
  }

  /// Tears the draft down. Called after a successful submit (the
  /// backend has the data) and on logout (different user, different
  /// draft).
  public func clear() throws {
    let url = directory.appendingPathComponent(activeDraftFilename)
    guard fileManager.fileExists(atPath: url.path) else { return }
    try fileManager.removeItem(at: url)
  }

  public func clearAll() throws {
    guard fileManager.fileExists(atPath: directory.path) else { return }
    try fileManager.removeItem(at: directory)
  }

  // MARK: - Internals

  private func ensureDirectory() throws {
    if fileManager.fileExists(atPath: directory.path) { return }
    do {
      try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    } catch {
      throw DriverApplicationDraftStoreError.directoryCreationFailed(directory, underlying: error)
    }
  }
}
