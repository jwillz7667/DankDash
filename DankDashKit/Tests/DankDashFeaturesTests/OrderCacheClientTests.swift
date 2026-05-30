import XCTest
import Foundation
import DankDashDomain
import DankDashStorage
@testable import DankDashFeatures

final class OrderCacheClientTests: XCTestCase {
  // MARK: - .live binding with temp directory

  func test_live_detailRoundTrips() async throws {
    let cache = makeTempCache()
    let client = OrderCacheClient.live(cache: cache)
    let detail = makeDetail()

    let hitBefore = await client.readDetail(detail.order.id)
    XCTAssertNil(hitBefore)

    await client.writeDetail(detail, detail.order.id)
    let hitAfter = await client.readDetail(detail.order.id)
    XCTAssertEqual(hitAfter, detail)

    await client.clearDetail(detail.order.id)
    let hitAfterClear = await client.readDetail(detail.order.id)
    XCTAssertNil(hitAfterClear)

    try cleanup(cache)
  }

  func test_live_listRoundTrips() async throws {
    let cache = makeTempCache()
    let client = OrderCacheClient.live(cache: cache)
    // Whole-second date — `.iso8601` strategy doesn't preserve fractional
    // seconds, so `Date()` would round-trip into a different instant.
    let list = CachedOrderList(
      items: [],
      nextCursor: "abc",
      cachedAt: Date(timeIntervalSinceReferenceDate: 0)
    )

    let hitBefore = await client.readList("active")
    XCTAssertNil(hitBefore)

    await client.writeList(list, "active")
    let hitAfter = await client.readList("active")
    XCTAssertEqual(hitAfter, list)

    await client.clearAll()
    let hitAfterClear = await client.readList("active")
    XCTAssertNil(hitAfterClear)

    try cleanup(cache)
  }

  func test_live_listFilterIsolation() async throws {
    let cache = makeTempCache()
    let client = OrderCacheClient.live(cache: cache)
    let cachedAt = Date(timeIntervalSinceReferenceDate: 0)
    let active = CachedOrderList(items: [], nextCursor: "active-cursor", cachedAt: cachedAt)
    let completed = CachedOrderList(items: [], nextCursor: "completed-cursor", cachedAt: cachedAt)

    await client.writeList(active, "active")
    await client.writeList(completed, "completed")

    let hitActive = await client.readList("active")
    let hitCompleted = await client.readList("completed")
    XCTAssertEqual(hitActive?.nextCursor, "active-cursor")
    XCTAssertEqual(hitCompleted?.nextCursor, "completed-cursor")

    try cleanup(cache)
  }

  // MARK: - .unimplemented

  func test_unimplemented_readsAlwaysMiss() async {
    let client = OrderCacheClient.unimplemented
    let detail = await client.readDetail(UUID())
    let list = await client.readList("active")
    await client.writeDetail(makeDetail(), UUID())
    await client.writeList(CachedOrderList(items: [], nextCursor: nil, cachedAt: Date()), "active")
    await client.clearDetail(UUID())
    await client.clearAll()
    XCTAssertNil(detail)
    XCTAssertNil(list)
  }

  // MARK: - Helpers

  private func makeTempCache() -> OrderCache {
    let tmp = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
      .appendingPathComponent("DankDashOrderCacheClientTests-\(UUID().uuidString)", isDirectory: true)
    return OrderCache(directory: tmp)
  }

  private func cleanup(_ cache: OrderCache) throws {
    if FileManager.default.fileExists(atPath: cache.directory.path) {
      try FileManager.default.removeItem(at: cache.directory)
    }
  }

  private func makeDetail() -> CachedOrderDetail {
    let orderId = UUID()
    let dispensaryId = UUID()
    let placedAt = Date(timeIntervalSinceReferenceDate: 0)
    let order = Order(
      id: orderId,
      shortCode: "AAA-001",
      userId: UUID(),
      dispensaryId: dispensaryId,
      deliveryAddressId: UUID(),
      status: .placed,
      subtotalCents: 1000,
      cannabisTaxCents: 100,
      salesTaxCents: 50,
      deliveryFeeCents: 500,
      driverTipCents: 0,
      discountCents: 0,
      totalCents: 1650,
      items: [],
      placedAt: placedAt,
      statusChangedAt: placedAt,
      createdAt: placedAt,
      updatedAt: placedAt
    )
    return CachedOrderDetail(
      order: order,
      events: [],
      driver: nil,
      cachedAt: placedAt
    )
  }
}
