import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashStorage

/// Domain-shaped catalog cache values. We bind each namespace to a
/// concrete Codable type here (rather than leaving the cache generic at
/// the reducer level) so the cache layer is type-safe top to bottom and
/// reducers cannot accidentally write the wrong shape into a namespace.
public extension CatalogCacheClient {
  /// Snapshot of a `GET /v1/dispensaries` response, projected through
  /// `.toDomain()`. The lat/lng key is rounded so two consecutive feed
  /// loads at the same intersection hit the same cache entry.
  struct FeedSnapshot: Codable, Sendable, Equatable {
    public let dispensaries: [Dispensary]
    public let queriedAt: Date

    public init(dispensaries: [Dispensary], queriedAt: Date) {
      self.dispensaries = dispensaries
      self.queriedAt = queriedAt
    }
  }

  /// Snapshot of a single dispensary's menu.
  struct MenuSnapshot: Codable, Sendable, Equatable {
    public let dispensaryId: UUID
    public let items: [MenuItem]

    public init(dispensaryId: UUID, items: [MenuItem]) {
      self.dispensaryId = dispensaryId
      self.items = items
    }
  }
}

/// `@DependencyClient`-style abstraction over ``CatalogCache``. Reducers
/// depend on this typed surface (not the raw cache) so test stores can
/// substitute fake implementations and the file system stays out of the
/// test loop.
public struct CatalogCacheClient: Sendable {
  public var readFeed: @Sendable (_ key: String) async -> FeedSnapshot?
  public var writeFeed: @Sendable (_ key: String, _ snapshot: FeedSnapshot) async -> Void
  public var readMenu: @Sendable (_ dispensaryId: UUID) async -> MenuSnapshot?
  public var writeMenu: @Sendable (_ dispensaryId: UUID, _ snapshot: MenuSnapshot) async -> Void
  public var readProduct: @Sendable (_ productId: UUID) async -> Product?
  public var writeProduct: @Sendable (_ productId: UUID, _ product: Product) async -> Void
  public var readCategories: @Sendable () async -> [DankDashDomain.Category]?
  public var writeCategories: @Sendable (_ categories: [DankDashDomain.Category]) async -> Void
  public var clearAll: @Sendable () async -> Void

  public init(
    readFeed: @Sendable @escaping (_ key: String) async -> FeedSnapshot?,
    writeFeed: @Sendable @escaping (_ key: String, _ snapshot: FeedSnapshot) async -> Void,
    readMenu: @Sendable @escaping (_ dispensaryId: UUID) async -> MenuSnapshot?,
    writeMenu: @Sendable @escaping (_ dispensaryId: UUID, _ snapshot: MenuSnapshot) async -> Void,
    readProduct: @Sendable @escaping (_ productId: UUID) async -> Product?,
    writeProduct: @Sendable @escaping (_ productId: UUID, _ product: Product) async -> Void,
    readCategories: @Sendable @escaping () async -> [DankDashDomain.Category]?,
    writeCategories: @Sendable @escaping (_ categories: [DankDashDomain.Category]) async -> Void,
    clearAll: @Sendable @escaping () async -> Void
  ) {
    self.readFeed = readFeed
    self.writeFeed = writeFeed
    self.readMenu = readMenu
    self.writeMenu = writeMenu
    self.readProduct = readProduct
    self.writeProduct = writeProduct
    self.readCategories = readCategories
    self.writeCategories = writeCategories
    self.clearAll = clearAll
  }
}

public extension CatalogCacheClient {
  /// Production binding over ``CatalogCache``. Read failures swallow to
  /// `nil` because cache misses are not errors — the reducer will fall
  /// through to a network fetch and overwrite the corrupt entry on
  /// success. Write failures also swallow so a non-writable caches
  /// directory never breaks a successful network round-trip.
  static func live(cache: CatalogCache = CatalogCache()) -> CatalogCacheClient {
    CatalogCacheClient(
      readFeed: { key in
        (try? cache.read(FeedSnapshot.self, forKey: key, namespace: .dispensaryFeed))?.value
      },
      writeFeed: { key, snapshot in
        try? cache.write(snapshot, forKey: key, namespace: .dispensaryFeed)
      },
      readMenu: { dispensaryId in
        (try? cache.read(MenuSnapshot.self, forKey: dispensaryId.uuidString, namespace: .dispensaryMenu))?.value
      },
      writeMenu: { dispensaryId, snapshot in
        try? cache.write(snapshot, forKey: dispensaryId.uuidString, namespace: .dispensaryMenu)
      },
      readProduct: { productId in
        (try? cache.read(Product.self, forKey: productId.uuidString, namespace: .product))?.value
      },
      writeProduct: { productId, product in
        try? cache.write(product, forKey: productId.uuidString, namespace: .product)
      },
      readCategories: {
        (try? cache.read([DankDashDomain.Category].self, forKey: "all", namespace: .categories))?.value
      },
      writeCategories: { categories in
        try? cache.write(categories, forKey: "all", namespace: .categories)
      },
      clearAll: { try? cache.clearAll() }
    )
  }

  /// Test fixture: all reads miss, all writes no-op. Reducer tests
  /// stub `readFeed`/`readMenu` etc. explicitly when they need a hit.
  static let unimplemented = CatalogCacheClient(
    readFeed: { _ in nil },
    writeFeed: { _, _ in },
    readMenu: { _ in nil },
    writeMenu: { _, _ in },
    readProduct: { _ in nil },
    writeProduct: { _, _ in },
    readCategories: { nil },
    writeCategories: { _ in },
    clearAll: {}
  )
}

public extension CatalogCacheClient {
  /// Stable cache key for a feed query. We quantize the coordinate to
  /// 3 decimal places (~110m at the equator) so two loads from the same
  /// city block share a cache entry, and write a `nil-location` token
  /// when the user hasn't granted location.
  static func feedKey(for coordinate: Coordinate?) -> String {
    guard let coordinate else { return "nil-location" }
    let lat = (coordinate.latitude * 1000).rounded() / 1000
    let lng = (coordinate.longitude * 1000).rounded() / 1000
    return String(format: "lat:%.3f_lng:%.3f", lat, lng)
  }
}

private enum CatalogCacheClientKey: DependencyKey {
  static let liveValue: CatalogCacheClient = .live()
  static let testValue: CatalogCacheClient = .unimplemented
}

public extension DependencyValues {
  var catalogCacheClient: CatalogCacheClient {
    get { self[CatalogCacheClientKey.self] }
    set { self[CatalogCacheClientKey.self] = newValue }
  }
}
