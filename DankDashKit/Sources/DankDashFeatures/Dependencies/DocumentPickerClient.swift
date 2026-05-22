import Foundation
import ComposableArchitecture

/// One picked file's metadata + on-disk URL. The URL points into the
/// app sandbox (Documents/Inbox/<uuid>.<ext>) — the picker copies the
/// imported file there so the reducer can hand the URL straight to
/// ``DocumentDraftStore.saveDocument`` without scoping a security URL.
public struct PickedDocument: Sendable, Equatable {
  public let url: URL
  public let mimeType: String
  public let sizeBytes: Int
  public let capturedAt: Date

  public init(url: URL, mimeType: String, sizeBytes: Int, capturedAt: Date) {
    self.url = url
    self.mimeType = mimeType
    self.sizeBytes = sizeBytes
    self.capturedAt = capturedAt
  }
}

/// `@DependencyClient`-style abstraction over the iOS document /
/// photo picker stack. The driver-app reducer asks for "one document"
/// and the live binding routes through `UIDocumentPickerViewController`
/// (PDF) or `PHPickerViewController` (photos). The protocol surface
/// returns the picked file as a `PickedDocument` so the reducer can
/// hand it to ``DocumentDraftStore.saveDocument(…)`` without touching
/// PhotosUI or UniformTypeIdentifiers.
///
/// `pick` is `async throws` so cancellation surfaces a typed
/// `.cancelled` and presentation failures surface `.unavailable`.
public struct DocumentPickerClient: Sendable {
  public var pick: @Sendable (DocumentPickerSource) async throws -> PickedDocument

  public init(
    pick: @Sendable @escaping (DocumentPickerSource) async throws -> PickedDocument
  ) {
    self.pick = pick
  }
}

/// Which native picker to present. PDF vs photo affects which UTType
/// list the picker accepts; the live binding picks the surface
/// accordingly.
public enum DocumentPickerSource: Sendable, Equatable {
  /// Photos library — HEIC/JPEG/PNG accepted. Used for driver's
  /// license + vehicle registration (photo of the physical card).
  case photoLibrary
  /// Files (`UIDocumentPickerViewController`) — accepts PDF in
  /// addition to images. Used for vehicle insurance, where
  /// declarations-page PDFs are common.
  case files
}

public enum DocumentPickerClientError: Error, Sendable, Equatable {
  case cancelled
  case unavailable
  case unsupportedType(String)
  case underlying(String)
}

public extension DocumentPickerClient {
  /// Production binding is wired in the `DankDasher` app target where
  /// the picker view controllers can be presented. Until then we
  /// surface a typed `.unavailable` so the package builds clean on
  /// macOS test runs and a missing-injection in the app target throws
  /// loudly instead of hanging.
  static let live: DocumentPickerClient = .unimplemented

  static let unimplemented = DocumentPickerClient(
    pick: { _ in throw DocumentPickerClientError.unavailable }
  )

  /// Convenience factory for `TestStore`: returns the supplied
  /// `PickedDocument` on every call.
  static func test(_ picked: PickedDocument) -> DocumentPickerClient {
    DocumentPickerClient(pick: { _ in picked })
  }

  /// Convenience factory that throws — used to drive the
  /// cancelled-picker reducer path.
  static func failing(_ error: DocumentPickerClientError) -> DocumentPickerClient {
    DocumentPickerClient(pick: { _ in throw error })
  }
}

private enum DocumentPickerClientKey: DependencyKey {
  static let liveValue: DocumentPickerClient = .live
  static let testValue: DocumentPickerClient = .unimplemented
}

public extension DependencyValues {
  var documentPickerClient: DocumentPickerClient {
    get { self[DocumentPickerClientKey.self] }
    set { self[DocumentPickerClientKey.self] = newValue }
  }
}
