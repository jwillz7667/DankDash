import XCTest
import DankDashDomain
@testable import DankDashStorage

/// Each test instantiates its own temp directory so parallel runs never
/// collide and a failed test cannot leak state into the next one.
final class OrderCacheTests: XCTestCase {
  private var directory: URL!
  private var cache: OrderCache!

  override func setUp() {
    super.setUp()
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("DankDashOrderTests-\(UUID().uuidString)", isDirectory: true)
    cache = OrderCache(directory: directory)
  }

  override func tearDown() {
    try? FileManager.default.removeItem(at: directory)
    cache = nil
    directory = nil
    super.tearDown()
  }

  // MARK: - Detail round-trip

  func test_writeDetail_thenRead_returnsExactlyWhatWasWritten() throws {
    let detail = Self.sampleDetail()
    try cache.writeDetail(detail, forOrderId: detail.order.id)

    let read = try cache.readDetail(forOrderId: detail.order.id)
    XCTAssertEqual(read, detail)
  }

  func test_readDetail_returnsNilWhenAbsent() throws {
    XCTAssertNil(try cache.readDetail(forOrderId: UUID()))
  }

  func test_writeDetail_overwritesPrevious() throws {
    let first = Self.sampleDetail(status: .placed)
    let second = Self.sampleDetail(status: .driverAssigned, orderId: first.order.id)
    try cache.writeDetail(first, forOrderId: first.order.id)
    try cache.writeDetail(second, forOrderId: first.order.id)

    let read = try cache.readDetail(forOrderId: first.order.id)
    XCTAssertEqual(read?.order.status, .driverAssigned)
  }

  func test_clearDetail_removesEntryAndOthersSurvive() throws {
    let a = Self.sampleDetail()
    let b = Self.sampleDetail()
    try cache.writeDetail(a, forOrderId: a.order.id)
    try cache.writeDetail(b, forOrderId: b.order.id)

    try cache.clearDetail(forOrderId: a.order.id)

    XCTAssertNil(try cache.readDetail(forOrderId: a.order.id))
    XCTAssertEqual(try cache.readDetail(forOrderId: b.order.id), b)
  }

  func test_clearDetail_isIdempotentForMissingEntry() throws {
    XCTAssertNoThrow(try cache.clearDetail(forOrderId: UUID()))
  }

  // MARK: - Expiry helper

  func test_cachedOrderDetail_isExpiredReflectsAgeRelativeToMaxAge() {
    let detail = Self.sampleDetail(cachedAt: Date(timeIntervalSince1970: 1_000))
    XCTAssertFalse(
      detail.isExpired(maxAge: 60, referenceDate: Date(timeIntervalSince1970: 1_059))
    )
    XCTAssertTrue(
      detail.isExpired(maxAge: 60, referenceDate: Date(timeIntervalSince1970: 1_061))
    )
  }

  func test_cachedOrderList_isExpiredReflectsAgeRelativeToMaxAge() {
    let list = CachedOrderList(
      items: [],
      nextCursor: nil,
      cachedAt: Date(timeIntervalSince1970: 1_000)
    )
    XCTAssertFalse(list.isExpired(maxAge: 60, referenceDate: Date(timeIntervalSince1970: 1_059)))
    XCTAssertTrue(list.isExpired(maxAge: 60, referenceDate: Date(timeIntervalSince1970: 1_061)))
  }

  // MARK: - List round-trip

  func test_writeList_thenRead_returnsExactlyWhatWasWritten() throws {
    let list = Self.sampleList()
    try cache.writeList(list, forFilter: "active")

    let read = try cache.readList(forFilter: "active")
    XCTAssertEqual(read, list)
  }

  func test_readList_returnsNilWhenAbsent() throws {
    XCTAssertNil(try cache.readList(forFilter: "completed"))
  }

  func test_writeList_overwritesPrevious() throws {
    let first = Self.sampleList(itemCount: 1)
    let second = Self.sampleList(itemCount: 3)
    try cache.writeList(first, forFilter: "active")
    try cache.writeList(second, forFilter: "active")

    let read = try cache.readList(forFilter: "active")
    XCTAssertEqual(read?.items.count, 3)
  }

  func test_writeList_isolatesFiltersFromEachOther() throws {
    let active = Self.sampleList(itemCount: 2)
    let completed = Self.sampleList(itemCount: 5)
    try cache.writeList(active, forFilter: "active")
    try cache.writeList(completed, forFilter: "completed")

    XCTAssertEqual(try cache.readList(forFilter: "active")?.items.count, 2)
    XCTAssertEqual(try cache.readList(forFilter: "completed")?.items.count, 5)
  }

  // MARK: - Wipe

  func test_clearAll_removesDetailsAndLists() throws {
    let detail = Self.sampleDetail()
    let list = Self.sampleList()
    try cache.writeDetail(detail, forOrderId: detail.order.id)
    try cache.writeList(list, forFilter: "active")

    try cache.clearAll()

    XCTAssertNil(try cache.readDetail(forOrderId: detail.order.id))
    XCTAssertNil(try cache.readList(forFilter: "active"))
  }

  func test_clearAll_isIdempotentWhenDirectoryAbsent() throws {
    XCTAssertNoThrow(try cache.clearAll())
    XCTAssertNoThrow(try cache.clearAll())
  }

  // MARK: - Filter sanitization

  func test_sanitize_replacesIllegalCharactersAndEmpty() {
    XCTAssertEqual(OrderCache.sanitize("active"), "active")
    // `.` is in the allowed set so `..` survives — only the path
    // separators get replaced. Result is still a flat filename.
    XCTAssertEqual(OrderCache.sanitize("../etc/passwd"), ".._etc_passwd")
    XCTAssertEqual(OrderCache.sanitize("with spaces"), "with_spaces")
    XCTAssertEqual(OrderCache.sanitize(""), "_")
  }

  func test_writeList_acceptsFilterWithPathSeparatorsByEscaping() throws {
    let raw = "../etc/passwd"
    try cache.writeList(Self.sampleList(), forFilter: raw)

    XCTAssertNotNil(try cache.readList(forFilter: raw))
  }

  // MARK: - Corrupt file surfaces typed error

  func test_readDetail_throwsDecodingFailedWhenFileIsCorrupt() throws {
    let detailsURL = directory.appendingPathComponent("details", isDirectory: true)
    try FileManager.default.createDirectory(at: detailsURL, withIntermediateDirectories: true)
    let id = UUID()
    let fileURL = detailsURL.appendingPathComponent(id.uuidString.lowercased() + ".json")
    try Data("{ not valid json".utf8).write(to: fileURL)

    XCTAssertThrowsError(try cache.readDetail(forOrderId: id)) { error in
      guard case OrderCacheError.decodingFailed = error else {
        return XCTFail("Expected .decodingFailed, got \(error)")
      }
    }
  }

  func test_readList_throwsDecodingFailedWhenFileIsCorrupt() throws {
    let listsURL = directory.appendingPathComponent("lists", isDirectory: true)
    try FileManager.default.createDirectory(at: listsURL, withIntermediateDirectories: true)
    let fileURL = listsURL.appendingPathComponent("active.json")
    try Data("{ not valid json".utf8).write(to: fileURL)

    XCTAssertThrowsError(try cache.readList(forFilter: "active")) { error in
      guard case OrderCacheError.decodingFailed = error else {
        return XCTFail("Expected .decodingFailed, got \(error)")
      }
    }
  }

  // MARK: - Concurrent writers don't corrupt

  /// The on-disk write is atomic per file (`.atomic` rename), and
  /// different orderIds map to different files, so independent writers
  /// must round-trip cleanly. This is the proof.
  func test_concurrentWritesToDistinctOrderIds_doNotCorrupt() async throws {
    let details: [CachedOrderDetail] = (0..<16).map { _ in Self.sampleDetail() }
    let cache = self.cache!

    try await withThrowingTaskGroup(of: Void.self) { group in
      for detail in details {
        group.addTask {
          try cache.writeDetail(detail, forOrderId: detail.order.id)
        }
      }
      try await group.waitForAll()
    }

    for detail in details {
      let read = try cache.readDetail(forOrderId: detail.order.id)
      XCTAssertEqual(read, detail)
    }
  }

  // MARK: - Fixtures

  private static func sampleDetail(
    status: OrderStatus = .placed,
    orderId: UUID = UUID(),
    cachedAt: Date = Date(timeIntervalSince1970: 1_700_000_000)
  ) -> CachedOrderDetail {
    CachedOrderDetail(
      order: sampleOrder(id: orderId, status: status),
      events: [sampleEvent(orderId: orderId)],
      driver: sampleDriver(),
      cachedAt: cachedAt
    )
  }

  private static func sampleList(itemCount: Int = 2) -> CachedOrderList {
    let items = (0..<itemCount).map { _ in sampleListItem() }
    return CachedOrderList(
      items: items,
      nextCursor: itemCount > 0 ? "cursor-\(itemCount)" : nil,
      cachedAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
  }

  private static func sampleOrder(id: UUID, status: OrderStatus) -> Order {
    Order(
      id: id,
      shortCode: "DD-ABC123",
      userId: UUID(),
      dispensaryId: UUID(),
      deliveryAddressId: UUID(),
      status: status,
      subtotalCents: 4500,
      cannabisTaxCents: 450,
      salesTaxCents: 100,
      deliveryFeeCents: 500,
      driverTipCents: 0,
      discountCents: 0,
      totalCents: 5550,
      items: [sampleOrderItem()],
      placedAt: Date(timeIntervalSince1970: 1_700_000_000),
      statusChangedAt: Date(timeIntervalSince1970: 1_700_000_010),
      createdAt: Date(timeIntervalSince1970: 1_700_000_000),
      updatedAt: Date(timeIntervalSince1970: 1_700_000_010)
    )
  }

  private static func sampleOrderItem() -> OrderItem {
    OrderItem(
      id: UUID(),
      listingId: UUID(),
      productSnapshot: .object([
        "name": .string("Sour Diesel 3.5g"),
        "brand": .string("DankCo"),
      ]),
      quantity: 1,
      unitPriceCents: 4500,
      lineSubtotalCents: 4500,
      thcMgTotal: Decimal(string: "800")!,
      cbdMgTotal: Decimal(string: "0")!,
      weightGramsTotal: Decimal(string: "3.5")!,
      cannabisTaxCents: 450,
      salesTaxCents: 100,
      createdAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
  }

  private static func sampleEvent(orderId: UUID) -> OrderEvent {
    OrderEvent(
      id: UUID(),
      orderId: orderId,
      eventType: "order_placed",
      actorUserId: nil,
      actorRole: "system",
      payload: .object([:]),
      occurredAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
  }

  private static func sampleDriver() -> DriverPublicProfile {
    DriverPublicProfile(
      id: UUID(),
      displayName: "Sam D.",
      avatarKey: nil,
      vehicleSummary: "Blue 2021 Honda Civic",
      maskedPhone: "+1 ••• ••• 1234"
    )
  }

  private static func sampleListItem() -> OrderListItem {
    OrderListItem(
      id: UUID(),
      shortCode: "DD-XYZ987",
      dispensaryId: UUID(),
      status: .placed,
      totalCents: 5550,
      placedAt: Date(timeIntervalSince1970: 1_700_000_000),
      statusChangedAt: Date(timeIntervalSince1970: 1_700_000_010)
    )
  }
}
