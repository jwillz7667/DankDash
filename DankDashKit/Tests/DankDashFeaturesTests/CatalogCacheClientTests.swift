import XCTest
import Foundation
import DankDashDomain
import DankDashStorage
@testable import DankDashFeatures

final class CatalogCacheClientTests: XCTestCase {
  func test_feedKey_quantizesCoordinateTo3Decimals() {
    let close1 = Coordinate(latitude: 44.97781, longitude: -93.26509)
    let close2 = Coordinate(latitude: 44.97799, longitude: -93.26491)
    // Both round to 44.978 / -93.265 → same key, so the second feed
    // load from the same block hits the same cache entry.
    XCTAssertEqual(
      CatalogCacheClient.feedKey(for: close1),
      CatalogCacheClient.feedKey(for: close2)
    )
  }

  func test_feedKey_distinctNeighborhoodsGetDistinctKeys() {
    let stPaul = Coordinate(latitude: 44.95, longitude: -93.10)
    let minneapolis = Coordinate(latitude: 44.98, longitude: -93.27)
    XCTAssertNotEqual(
      CatalogCacheClient.feedKey(for: stPaul),
      CatalogCacheClient.feedKey(for: minneapolis)
    )
  }

  func test_feedKey_nilCoordinateGetsItsOwnKey() {
    XCTAssertEqual(CatalogCacheClient.feedKey(for: nil), "nil-location")
  }

  func test_liveBinding_roundTripsFeedSnapshot() async throws {
    let directory = URL(
      fileURLWithPath: NSTemporaryDirectory(),
      isDirectory: true
    ).appendingPathComponent("catalog-cache-tests-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }

    let cache = CatalogCache(directory: directory)
    let client = CatalogCacheClient.live(cache: cache)

    let snapshot = CatalogCacheClient.FeedSnapshot(
      dispensaries: [],
      queriedAt: Date(timeIntervalSince1970: 1_780_000_000)
    )
    await client.writeFeed("nil-location", snapshot)
    let read = await client.readFeed("nil-location")
    XCTAssertEqual(read, snapshot)
  }

  func test_liveBinding_clearAllRemovesEntries() async throws {
    let directory = URL(
      fileURLWithPath: NSTemporaryDirectory(),
      isDirectory: true
    ).appendingPathComponent("catalog-cache-tests-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }

    let cache = CatalogCache(directory: directory)
    let client = CatalogCacheClient.live(cache: cache)
    let snapshot = CatalogCacheClient.FeedSnapshot(dispensaries: [], queriedAt: Date())
    await client.writeFeed("k", snapshot)

    await client.clearAll()

    let read = await client.readFeed("k")
    XCTAssertNil(read)
  }

  func test_unimplementedClient_allReadsMiss_writesNoOp() async {
    let client = CatalogCacheClient.unimplemented
    let feed = await client.readFeed("anything")
    let menu = await client.readMenu(UUID())
    let product = await client.readProduct(UUID())
    let categories = await client.readCategories()
    XCTAssertNil(feed)
    XCTAssertNil(menu)
    XCTAssertNil(product)
    XCTAssertNil(categories)
    // writes should not throw — they are async non-throwing closures
    await client.writeFeed("k", .init(dispensaries: [], queriedAt: Date()))
    await client.writeMenu(UUID(), .init(dispensaryId: UUID(), items: []))
    await client.clearAll()
  }
}
