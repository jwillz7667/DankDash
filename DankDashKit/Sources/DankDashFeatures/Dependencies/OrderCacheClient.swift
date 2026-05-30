import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashStorage

/// `@DependencyClient`-style abstraction over ``OrderCache``. Reducers
/// depend on this typed surface (not the raw cache) so test stores can
/// substitute fake implementations and the file system stays out of the
/// test loop.
///
/// Read failures swallow to `nil` because cache misses are not errors —
/// the tracking screen falls through to a network fetch. Write failures
/// also swallow so a non-writable caches directory never breaks a
/// successful network round-trip.
public struct OrderCacheClient: Sendable {
  public var readDetail: @Sendable (_ orderId: UUID) async -> CachedOrderDetail?
  public var writeDetail: @Sendable (_ detail: CachedOrderDetail, _ orderId: UUID) async -> Void
  public var clearDetail: @Sendable (_ orderId: UUID) async -> Void
  public var readList: @Sendable (_ filter: String) async -> CachedOrderList?
  public var writeList: @Sendable (_ list: CachedOrderList, _ filter: String) async -> Void
  public var clearAll: @Sendable () async -> Void

  public init(
    readDetail: @Sendable @escaping (_ orderId: UUID) async -> CachedOrderDetail?,
    writeDetail: @Sendable @escaping (_ detail: CachedOrderDetail, _ orderId: UUID) async -> Void,
    clearDetail: @Sendable @escaping (_ orderId: UUID) async -> Void,
    readList: @Sendable @escaping (_ filter: String) async -> CachedOrderList?,
    writeList: @Sendable @escaping (_ list: CachedOrderList, _ filter: String) async -> Void,
    clearAll: @Sendable @escaping () async -> Void
  ) {
    self.readDetail = readDetail
    self.writeDetail = writeDetail
    self.clearDetail = clearDetail
    self.readList = readList
    self.writeList = writeList
    self.clearAll = clearAll
  }
}

public extension OrderCacheClient {
  /// Production binding over ``OrderCache``. The cache directory defaults
  /// to ``OrderCache.defaultDirectory`` under `~/Library/Caches`.
  static func live(cache: OrderCache = OrderCache()) -> OrderCacheClient {
    OrderCacheClient(
      readDetail: { orderId in
        try? cache.readDetail(forOrderId: orderId)
      },
      writeDetail: { detail, orderId in
        try? cache.writeDetail(detail, forOrderId: orderId)
      },
      clearDetail: { orderId in
        try? cache.clearDetail(forOrderId: orderId)
      },
      readList: { filter in
        try? cache.readList(forFilter: filter)
      },
      writeList: { list, filter in
        try? cache.writeList(list, forFilter: filter)
      },
      clearAll: { try? cache.clearAll() }
    )
  }

  /// Test fixture: all reads miss, all writes no-op. Reducer tests
  /// stub `readDetail`/`readList` explicitly when they need a hit.
  static let unimplemented = OrderCacheClient(
    readDetail: { _ in nil },
    writeDetail: { _, _ in },
    clearDetail: { _ in },
    readList: { _ in nil },
    writeList: { _, _ in },
    clearAll: {}
  )
}

private enum OrderCacheClientKey: DependencyKey {
  static let liveValue: OrderCacheClient = .live()
  static let testValue: OrderCacheClient = .unimplemented
}

public extension DependencyValues {
  var orderCacheClient: OrderCacheClient {
    get { self[OrderCacheClientKey.self] }
    set { self[OrderCacheClientKey.self] = newValue }
  }
}
