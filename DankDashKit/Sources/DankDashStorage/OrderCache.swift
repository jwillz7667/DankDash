import Foundation
import DankDashDomain

/// Errors surfaced by ``OrderCache``. Mirrors ``CatalogCacheError`` —
/// callers usually only branch on "was there a value, was it fresh"; the
/// typed cases let them distinguish a missing entry from a real I/O
/// failure on the rare path where it matters.
public enum OrderCacheError: Error, Sendable {
  case directoryCreationFailed(URL, underlying: Error)
  case writeFailed(URL, underlying: Error)
  case readFailed(URL, underlying: Error)
  case encodingFailed(underlying: Error)
  case decodingFailed(underlying: Error)
}

/// Cached order-detail bundle — the same triple
/// (`order`, `events`, `driver?`) the tracking screen reads. Lives in
/// Storage rather than Domain because the bundle isn't a Domain concept;
/// it's a cache-layer view that exists only so the tracking screen can
/// render an "approximately right" snapshot on cold start without
/// waiting for the network.
public struct CachedOrderDetail: Codable, Sendable, Equatable {
  public let order: Order
  public let events: [OrderEvent]
  public let driver: DriverPublicProfile?
  public let cachedAt: Date

  /// Map-point snapshot, mirrored from the detail response so the
  /// tracking screen can render ``LiveMapView`` instantly on cold start.
  /// These are `Optional` (not the non-optional Domain shape) on purpose:
  /// entries written by an older build predate these fields, and the
  /// `decodeIfPresent` the synthesized `Codable` uses for `Optional`
  /// lets those legacy files decode to `nil` rather than throwing. A
  /// `nil` drop-off coordinate simply means "no map until the next
  /// network refresh fills it in".
  public let dispensaryName: String?
  public let dispensaryCoordinate: Coordinate?
  public let dropoffCoordinate: Coordinate?
  public let dropoffLabel: String?

  public init(
    order: Order,
    events: [OrderEvent],
    driver: DriverPublicProfile?,
    cachedAt: Date,
    dispensaryName: String? = nil,
    dispensaryCoordinate: Coordinate? = nil,
    dropoffCoordinate: Coordinate? = nil,
    dropoffLabel: String? = nil
  ) {
    self.order = order
    self.events = events
    self.driver = driver
    self.cachedAt = cachedAt
    self.dispensaryName = dispensaryName
    self.dispensaryCoordinate = dispensaryCoordinate
    self.dropoffCoordinate = dropoffCoordinate
    self.dropoffLabel = dropoffLabel
  }

  /// Convenience freshness check. The tracking screen treats a cached
  /// detail as "good enough to render while we re-fetch" for ~60s; older
  /// entries still render but a `staleSince` banner appears.
  public func isExpired(maxAge: TimeInterval, referenceDate: Date = Date()) -> Bool {
    referenceDate.timeIntervalSince(cachedAt) > maxAge
  }
}

/// Cached order-list bundle — same shape the Orders tab paginates with.
/// We cache the *first page* of each filter only; subsequent pages are
/// fetched fresh because their entries are fundamentally bound to a
/// cursor that changes with every insert.
public struct CachedOrderList: Codable, Sendable, Equatable {
  public let items: [OrderListItem]
  public let nextCursor: String?
  public let cachedAt: Date

  public init(
    items: [OrderListItem],
    nextCursor: String?,
    cachedAt: Date
  ) {
    self.items = items
    self.nextCursor = nextCursor
    self.cachedAt = cachedAt
  }

  public func isExpired(maxAge: TimeInterval, referenceDate: Date = Date()) -> Bool {
    referenceDate.timeIntervalSince(cachedAt) > maxAge
  }
}

/// File-backed JSON store for order detail + first-page list snapshots.
/// Separate from ``CatalogCache`` because the lifecycle is different —
/// catalog rows refresh on every network read whether stale or not,
/// while orders are read-once-cache-many (the tracking screen reads the
/// cache before issuing the network call so the timeline appears
/// immediately).
///
/// Layout: `<directory>/details/<orderId>.json` for detail bundles,
/// `<directory>/lists/<status>.json` for the first page per filter.
/// `clearAll()` is called from logout (different user, different orders).
///
/// `@unchecked Sendable` follows the ``CatalogCache`` precedent —
/// `FileManager` is documented thread-safe; the wrapper is otherwise
/// pure value semantics.
public struct OrderCache: @unchecked Sendable {
  public let directory: URL

  private let fileManager: FileManager
  private let encoder: JSONEncoder
  private let decoder: JSONDecoder

  /// Default singleton-style location under `~/Library/Caches`. Distinct
  /// directory from the catalog cache so wiping one doesn't punish the
  /// other (the Orders tab can legitimately survive a catalog flush).
  public static let defaultDirectory: URL = {
    let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    return base.appendingPathComponent("DankDashOrders", isDirectory: true)
  }()

  public init(
    directory: URL = OrderCache.defaultDirectory,
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

  // MARK: - Order detail (per-orderId)

  /// Writes `detail` under `orderId`. Atomic on-disk swap so a process
  /// kill mid-write can't leave a half-encoded payload behind.
  public func writeDetail(
    _ detail: CachedOrderDetail,
    forOrderId orderId: UUID
  ) throws {
    let payload: Data
    do {
      payload = try encoder.encode(detail)
    } catch {
      throw OrderCacheError.encodingFailed(underlying: error)
    }
    let fileURL = try ensureDirectory(.details)
      .appendingPathComponent(orderId.uuidString.lowercased() + ".json")
    do {
      try payload.write(to: fileURL, options: [.atomic])
    } catch {
      throw OrderCacheError.writeFailed(fileURL, underlying: error)
    }
  }

  /// Reads the detail at `orderId` or nil if absent. Missing → nil;
  /// corrupt JSON → throws so the caller can surface a "couldn't read
  /// cache" telemetry event (it's a bug, not a normal flow).
  public func readDetail(forOrderId orderId: UUID) throws -> CachedOrderDetail? {
    let fileURL = directory
      .appendingPathComponent(Subdir.details.rawValue, isDirectory: true)
      .appendingPathComponent(orderId.uuidString.lowercased() + ".json")
    guard fileManager.fileExists(atPath: fileURL.path) else { return nil }

    let data: Data
    do {
      data = try Data(contentsOf: fileURL)
    } catch {
      throw OrderCacheError.readFailed(fileURL, underlying: error)
    }
    do {
      return try decoder.decode(CachedOrderDetail.self, from: data)
    } catch {
      throw OrderCacheError.decodingFailed(underlying: error)
    }
  }

  public func clearDetail(forOrderId orderId: UUID) throws {
    let fileURL = directory
      .appendingPathComponent(Subdir.details.rawValue, isDirectory: true)
      .appendingPathComponent(orderId.uuidString.lowercased() + ".json")
    guard fileManager.fileExists(atPath: fileURL.path) else { return }
    try fileManager.removeItem(at: fileURL)
  }

  // MARK: - Order list (per-status filter)

  /// Writes the first page of a filtered list. The cache key is the
  /// raw filter string ("active" / "completed" / "all") so the same
  /// filter overwrites in place rather than accumulating stale pages.
  public func writeList(
    _ list: CachedOrderList,
    forFilter filter: String
  ) throws {
    let payload: Data
    do {
      payload = try encoder.encode(list)
    } catch {
      throw OrderCacheError.encodingFailed(underlying: error)
    }
    let fileURL = try ensureDirectory(.lists)
      .appendingPathComponent(Self.sanitize(filter) + ".json")
    do {
      try payload.write(to: fileURL, options: [.atomic])
    } catch {
      throw OrderCacheError.writeFailed(fileURL, underlying: error)
    }
  }

  public func readList(forFilter filter: String) throws -> CachedOrderList? {
    let fileURL = directory
      .appendingPathComponent(Subdir.lists.rawValue, isDirectory: true)
      .appendingPathComponent(Self.sanitize(filter) + ".json")
    guard fileManager.fileExists(atPath: fileURL.path) else { return nil }

    let data: Data
    do {
      data = try Data(contentsOf: fileURL)
    } catch {
      throw OrderCacheError.readFailed(fileURL, underlying: error)
    }
    do {
      return try decoder.decode(CachedOrderList.self, from: data)
    } catch {
      throw OrderCacheError.decodingFailed(underlying: error)
    }
  }

  // MARK: - Wipes

  /// Wipes the entire cache directory. Called on logout so a different
  /// user doesn't see the previous user's order list / detail snapshots.
  public func clearAll() throws {
    guard fileManager.fileExists(atPath: directory.path) else { return }
    try fileManager.removeItem(at: directory)
  }

  // MARK: - Internals

  private enum Subdir: String {
    case details
    case lists
  }

  private func ensureDirectory(_ subdir: Subdir) throws -> URL {
    let url = directory.appendingPathComponent(subdir.rawValue, isDirectory: true)
    do {
      try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
    } catch {
      throw OrderCacheError.directoryCreationFailed(url, underlying: error)
    }
    return url
  }

  /// Mirrors ``CatalogCache.sanitize`` so unfamiliar filter strings can't
  /// land an unfortunate filename — we don't trust the caller to pass
  /// only alphanumerics.
  static func sanitize(_ key: String) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._:")
    let scalars = key.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" }
    let collapsed = String(scalars)
    return collapsed.isEmpty ? "_" : collapsed
  }
}
