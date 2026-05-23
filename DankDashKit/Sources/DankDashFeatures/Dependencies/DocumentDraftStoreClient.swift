import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashStorage

/// `@DependencyClient`-style abstraction over ``DocumentDraftStore``.
/// The driver onboarding reducer uses this to copy picked documents
/// into the app sandbox and to flush them on logout / successful
/// submit.
///
/// The store is keyed by draft id (one folder per draft submission)
/// and by slot inside that folder; the onboarding reducer holds the
/// draft id in state and threads it through every call.
public struct DocumentDraftStoreClient: Sendable {
  public var saveDocument: @Sendable (
    _ draftId: UUID,
    _ documentId: UUID,
    _ slot: DocumentSlot,
    _ sourceFileURL: URL,
    _ mimeType: String,
    _ capturedAt: Date,
    _ sizeBytes: Int
  ) async throws -> URL

  public var removeDocument: @Sendable (
    _ draftId: UUID,
    _ slot: DocumentSlot
  ) async throws -> Void

  public var clear: @Sendable (_ draftId: UUID) async throws -> Void

  public var clearAll: @Sendable () async throws -> Void

  public init(
    saveDocument: @Sendable @escaping (
      _ draftId: UUID,
      _ documentId: UUID,
      _ slot: DocumentSlot,
      _ sourceFileURL: URL,
      _ mimeType: String,
      _ capturedAt: Date,
      _ sizeBytes: Int
    ) async throws -> URL,
    removeDocument: @Sendable @escaping (
      _ draftId: UUID,
      _ slot: DocumentSlot
    ) async throws -> Void,
    clear: @Sendable @escaping (_ draftId: UUID) async throws -> Void,
    clearAll: @Sendable @escaping () async throws -> Void
  ) {
    self.saveDocument = saveDocument
    self.removeDocument = removeDocument
    self.clear = clear
    self.clearAll = clearAll
  }
}

public extension DocumentDraftStoreClient {
  static func live(
    store: DocumentDraftStore = DocumentDraftStore()
  ) -> DocumentDraftStoreClient {
    DocumentDraftStoreClient(
      saveDocument: { draftId, documentId, slot, sourceURL, mimeType, capturedAt, sizeBytes in
        try store.saveDocument(
          draftId: draftId,
          documentId: documentId,
          slot: slot.rawValue,
          sourceFileURL: sourceURL,
          mimeType: mimeType,
          capturedAt: capturedAt,
          sizeBytes: sizeBytes
        )
      },
      removeDocument: { draftId, slot in
        try store.removeDocument(draftId: draftId, slot: slot.rawValue)
      },
      clear: { draftId in try store.clear(draftId: draftId) },
      clearAll: { try store.clearAll() }
    )
  }

  static let unimplemented = DocumentDraftStoreClient(
    saveDocument: { _, _, _, _, _, _, _ in
      throw DocumentDraftStoreError.sourceFileMissing(URL(fileURLWithPath: "/dev/null"))
    },
    removeDocument: { _, _ in },
    clear: { _ in },
    clearAll: {}
  )
}

private enum DocumentDraftStoreClientKey: DependencyKey {
  static let liveValue: DocumentDraftStoreClient = .live()
  static let testValue: DocumentDraftStoreClient = .unimplemented
}

public extension DependencyValues {
  var documentDraftStoreClient: DocumentDraftStoreClient {
    get { self[DocumentDraftStoreClientKey.self] }
    set { self[DocumentDraftStoreClientKey.self] = newValue }
  }
}
