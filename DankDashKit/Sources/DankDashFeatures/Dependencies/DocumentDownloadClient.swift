import Foundation
import ComposableArchitecture

/// Downloads a remote document (typically a COA PDF) to a local file
/// URL suitable for handing to `QLPreviewController`. Wrapped as a
/// dependency so the reducer can substitute a deterministic closure in
/// tests rather than making a real HTTP round-trip.
public struct DocumentDownloadClient: Sendable {
  /// Download the remote `URL` to the caller's caches directory and
  /// return the local file URL. Throws if the response is non-2xx or
  /// the network call fails.
  public var download: @Sendable (_ remote: URL) async throws -> URL

  public init(download: @Sendable @escaping (URL) async throws -> URL) {
    self.download = download
  }
}

/// Narrow error surface for `DocumentDownloadClient`. The reducer maps
/// these onto a single user-facing string; the cases exist so future
/// instrumentation can distinguish causes.
public enum DocumentDownloadError: Error, Sendable, Equatable {
  case invalidResponse
  case transport
  case unimplemented
}

public extension DocumentDownloadClient {
  /// Production binding using a shared `URLSession`. Downloads the
  /// remote URL via `data(from:)`, validates 2xx, writes the bytes to a
  /// unique file under `URL.cachesDirectory`, and returns the file URL.
  static let live: DocumentDownloadClient = {
    DocumentDownloadClient { remote in
      let (data, response) = try await URLSession.shared.data(from: remote)
      guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
        throw DocumentDownloadError.invalidResponse
      }
      let cachesRoot = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
      let directory = cachesRoot.appendingPathComponent("DankDashCOA", isDirectory: true)
      try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let filename = remote.lastPathComponent.isEmpty
        ? "\(UUID().uuidString).pdf"
        : remote.lastPathComponent
      let localURL = directory.appendingPathComponent(filename)
      try data.write(to: localURL, options: .atomic)
      return localURL
    }
  }()

  /// Test fixture that always throws. Reducer tests override with a
  /// closure that returns a constant file URL.
  static let unimplemented = DocumentDownloadClient { _ in
    throw DocumentDownloadError.unimplemented
  }
}

private enum DocumentDownloadClientKey: DependencyKey {
  static let liveValue: DocumentDownloadClient = .live
  static let testValue: DocumentDownloadClient = .unimplemented
}

public extension DependencyValues {
  var documentDownloadClient: DocumentDownloadClient {
    get { self[DocumentDownloadClientKey.self] }
    set { self[DocumentDownloadClientKey.self] = newValue }
  }
}
