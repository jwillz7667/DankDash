import Foundation

/// Errors surfaced by ``CatalogCache``. Most call sites care only about
/// whether the value was present and fresh — the typed error lets them
/// distinguish a missing entry from a real I/O failure.
public enum CatalogCacheError: Error, Sendable {
  case directoryCreationFailed(URL, underlying: Error)
  case writeFailed(URL, underlying: Error)
  case readFailed(URL, underlying: Error)
  case encodingFailed(underlying: Error)
  case decodingFailed(underlying: Error)
}

/// A payload that was previously written to ``CatalogCache``, along with
/// the instant it was persisted. Callers use ``writtenAt`` to decide
/// whether the entry is still fresh — the cache itself is TTL-agnostic
/// because different surfaces (feed, menu, product) have different
/// acceptable staleness windows.
public struct CachedPayload<Value: Codable & Sendable & Equatable>: Codable, Sendable, Equatable {
  public let value: Value
  public let writtenAt: Date

  public init(value: Value, writtenAt: Date) {
    self.value = value
    self.writtenAt = writtenAt
  }

  /// Convenience: returns true when `writtenAt` is older than `maxAge`
  /// relative to `referenceDate` (defaults to now).
  public func isExpired(maxAge: TimeInterval, referenceDate: Date = Date()) -> Bool {
    referenceDate.timeIntervalSince(writtenAt) > maxAge
  }
}

/// A small file-backed JSON store for catalog payloads (dispensary feed,
/// menu, product detail, search facets). The wire shapes are large enough
/// that re-encoding into Keychain or UserDefaults would be wasteful, but
/// short-lived enough that a real database (SwiftData / SQLite) is
/// overkill — the cache is allowed to disappear at any time and the next
/// network round-trip refills it.
///
/// Entries are stored under `URL.cachesDirectory/<namespace>/<sanitized-key>.json`
/// by default. Tests pass a temp directory via ``init(directory:)`` so
/// they can wipe their state without touching the simulator's caches.
/// `FileManager` itself is thread-safe (per its docs) but not formally
/// `Sendable`. We mark the wrapper `@unchecked Sendable` because the
/// struct is otherwise pure value semantics over its `directory` URL and
/// pre-configured coders.
public struct CatalogCache: @unchecked Sendable {
  /// The on-disk root for this cache instance. The default points at the
  /// system caches directory, which the OS may reclaim at any time —
  /// matching the cache's "best-effort" contract.
  public let directory: URL

  private let fileManager: FileManager
  private let encoder: JSONEncoder
  private let decoder: JSONDecoder

  /// Default singleton-style location under `~/Library/Caches`.
  public static let defaultDirectory: URL = {
    let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    return base.appendingPathComponent("DankDashCatalog", isDirectory: true)
  }()

  public init(
    directory: URL = CatalogCache.defaultDirectory,
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

  /// Persists `value` under `key` in `namespace`. The write is atomic
  /// (`.atomic` option) so partial writes are never observable. The
  /// `writtenAt` field is set to `clock()` (defaults to now) so tests
  /// can inject deterministic timestamps.
  public func write<Value: Codable & Sendable & Equatable>(
    _ value: Value,
    forKey key: String,
    namespace: Namespace,
    clock: () -> Date = Date.init
  ) throws {
    let payload = CachedPayload(value: value, writtenAt: clock())
    let data: Data
    do {
      data = try encoder.encode(payload)
    } catch {
      throw CatalogCacheError.encodingFailed(underlying: error)
    }

    let namespaceURL = directory.appendingPathComponent(namespace.rawValue, isDirectory: true)
    do {
      try fileManager.createDirectory(at: namespaceURL, withIntermediateDirectories: true)
    } catch {
      throw CatalogCacheError.directoryCreationFailed(namespaceURL, underlying: error)
    }

    let fileURL = namespaceURL.appendingPathComponent(Self.sanitize(key) + ".json")
    do {
      try data.write(to: fileURL, options: [.atomic])
    } catch {
      throw CatalogCacheError.writeFailed(fileURL, underlying: error)
    }
  }

  /// Reads the payload at `key` in `namespace`. Returns nil when the file
  /// doesn't exist — the cache is best-effort, so a missing entry is not
  /// an error. Other I/O or decoding failures throw.
  public func read<Value: Codable & Sendable & Equatable>(
    _ type: Value.Type,
    forKey key: String,
    namespace: Namespace
  ) throws -> CachedPayload<Value>? {
    let fileURL = directory
      .appendingPathComponent(namespace.rawValue, isDirectory: true)
      .appendingPathComponent(Self.sanitize(key) + ".json")
    guard fileManager.fileExists(atPath: fileURL.path) else { return nil }

    let data: Data
    do {
      data = try Data(contentsOf: fileURL)
    } catch {
      throw CatalogCacheError.readFailed(fileURL, underlying: error)
    }
    do {
      return try decoder.decode(CachedPayload<Value>.self, from: data)
    } catch {
      throw CatalogCacheError.decodingFailed(underlying: error)
    }
  }

  /// Removes the single entry at `key` in `namespace`. Missing entries
  /// are silently ignored so the API is idempotent.
  public func clear(key: String, namespace: Namespace) throws {
    let fileURL = directory
      .appendingPathComponent(namespace.rawValue, isDirectory: true)
      .appendingPathComponent(Self.sanitize(key) + ".json")
    guard fileManager.fileExists(atPath: fileURL.path) else { return }
    try fileManager.removeItem(at: fileURL)
  }

  /// Removes every entry inside `namespace`. Missing namespaces are
  /// silently ignored.
  public func clear(namespace: Namespace) throws {
    let namespaceURL = directory.appendingPathComponent(namespace.rawValue, isDirectory: true)
    guard fileManager.fileExists(atPath: namespaceURL.path) else { return }
    try fileManager.removeItem(at: namespaceURL)
  }

  /// Wipes the entire cache directory. Used on logout so a different
  /// user doesn't see the previous user's cached state.
  public func clearAll() throws {
    guard fileManager.fileExists(atPath: directory.path) else { return }
    try fileManager.removeItem(at: directory)
  }

  /// Replaces unsafe filename characters with `_` so callers can use the
  /// raw key from a URL or coordinate string without worrying about path
  /// separators or platform-illegal chars.
  static func sanitize(_ key: String) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._:")
    let scalars = key.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" }
    let collapsed = String(scalars)
    return collapsed.isEmpty ? "_" : collapsed
  }
}

public extension CatalogCache {
  /// Per-surface namespace. Adding a new endpoint? Add a case here so
  /// the on-disk layout stays self-documenting and `clear(namespace:)`
  /// stays granular.
  enum Namespace: String, Sendable, CaseIterable {
    case dispensaryFeed = "feed"
    case dispensaryMenu = "menu"
    case product = "product"
    case categories = "categories"
    case search = "search"
  }
}
