import XCTest
import DankDashDomain
@testable import DankDashStorage

/// Each test gets its own temp directory so parallel runs cannot collide
/// and a failed test cannot leak state into the next one.
final class CatalogCacheTests: XCTestCase {
  private var directory: URL!
  private var cache: CatalogCache!

  override func setUp() {
    super.setUp()
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("DankDashCatalogTests-\(UUID().uuidString)", isDirectory: true)
    cache = CatalogCache(directory: directory)
  }

  override func tearDown() {
    try? FileManager.default.removeItem(at: directory)
    cache = nil
    directory = nil
    super.tearDown()
  }

  // MARK: - Basic round-trip

  func test_write_thenRead_returnsValueAndWrittenAt() throws {
    let payload = SamplePayload(name: "Sour Diesel", priceCents: 4500)
    let writtenAt = Date(timeIntervalSince1970: 1_700_000_000)

    try cache.write(payload, forKey: "abc", namespace: .product, clock: { writtenAt })

    let cached = try cache.read(SamplePayload.self, forKey: "abc", namespace: .product)
    XCTAssertEqual(cached?.value, payload)
    XCTAssertEqual(cached?.writtenAt, writtenAt)
  }

  func test_read_returnsNilWhenNothingWritten() throws {
    let cached = try cache.read(SamplePayload.self, forKey: "missing", namespace: .product)
    XCTAssertNil(cached)
  }

  func test_write_overwritesPreviousValue() throws {
    let first = SamplePayload(name: "Sour Diesel", priceCents: 4500)
    let second = SamplePayload(name: "Sour Diesel", priceCents: 5000)
    try cache.write(first, forKey: "k", namespace: .product, clock: { Date(timeIntervalSince1970: 1) })
    try cache.write(second, forKey: "k", namespace: .product, clock: { Date(timeIntervalSince1970: 2) })

    let cached = try cache.read(SamplePayload.self, forKey: "k", namespace: .product)
    XCTAssertEqual(cached?.value, second)
    XCTAssertEqual(cached?.writtenAt, Date(timeIntervalSince1970: 2))
  }

  // MARK: - Expiry helper

  func test_isExpired_reflectsAgeRelativeToMaxAge() {
    let payload = CachedPayload(
      value: SamplePayload(name: "x", priceCents: 1),
      writtenAt: Date(timeIntervalSince1970: 1_000)
    )
    XCTAssertFalse(
      payload.isExpired(maxAge: 60, referenceDate: Date(timeIntervalSince1970: 1_059))
    )
    XCTAssertTrue(
      payload.isExpired(maxAge: 60, referenceDate: Date(timeIntervalSince1970: 1_061))
    )
  }

  // MARK: - Clear semantics

  func test_clearKey_removesEntryAndOthersSurvive() throws {
    let a = SamplePayload(name: "A", priceCents: 100)
    let b = SamplePayload(name: "B", priceCents: 200)
    try cache.write(a, forKey: "a", namespace: .product)
    try cache.write(b, forKey: "b", namespace: .product)

    try cache.clear(key: "a", namespace: .product)

    XCTAssertNil(try cache.read(SamplePayload.self, forKey: "a", namespace: .product))
    XCTAssertEqual(try cache.read(SamplePayload.self, forKey: "b", namespace: .product)?.value, b)
  }

  func test_clearKey_isIdempotentForMissingEntry() throws {
    XCTAssertNoThrow(try cache.clear(key: "never-written", namespace: .product))
  }

  func test_clearNamespace_removesAllEntriesInThatNamespace() throws {
    try cache.write(
      SamplePayload(name: "Menu", priceCents: 1),
      forKey: "m1",
      namespace: .dispensaryMenu
    )
    try cache.write(
      SamplePayload(name: "Product", priceCents: 2),
      forKey: "p1",
      namespace: .product
    )

    try cache.clear(namespace: .dispensaryMenu)

    XCTAssertNil(try cache.read(SamplePayload.self, forKey: "m1", namespace: .dispensaryMenu))
    XCTAssertNotNil(try cache.read(SamplePayload.self, forKey: "p1", namespace: .product))
  }

  func test_clearAll_removesEveryEntryAcrossNamespaces() throws {
    try cache.write(SamplePayload(name: "M", priceCents: 1), forKey: "m", namespace: .dispensaryMenu)
    try cache.write(SamplePayload(name: "P", priceCents: 2), forKey: "p", namespace: .product)

    try cache.clearAll()

    XCTAssertNil(try cache.read(SamplePayload.self, forKey: "m", namespace: .dispensaryMenu))
    XCTAssertNil(try cache.read(SamplePayload.self, forKey: "p", namespace: .product))
  }

  // MARK: - Key sanitization

  func test_sanitize_replacesPathSeparatorsAndIllegalChars() {
    XCTAssertEqual(CatalogCache.sanitize("feed:nearby:44.95,-93.10"), "feed:nearby:44.95_-93.10")
    XCTAssertEqual(CatalogCache.sanitize("/etc/passwd"), "_etc_passwd")
    XCTAssertEqual(CatalogCache.sanitize(""), "_")
  }

  func test_write_acceptsKeysWithPathSeparatorsByEscaping() throws {
    let payload = SamplePayload(name: "Z", priceCents: 9)
    let rawKey = "feed:nearby:44.95,-93.10"
    try cache.write(payload, forKey: rawKey, namespace: .dispensaryFeed)

    let cached = try cache.read(SamplePayload.self, forKey: rawKey, namespace: .dispensaryFeed)
    XCTAssertEqual(cached?.value, payload)
  }

  // MARK: - Encodes Domain types end-to-end

  func test_write_thenRead_handlesDomainDispensary() throws {
    let dispensary = sampleDispensary()
    try cache.write(dispensary, forKey: dispensary.id.uuidString, namespace: .dispensaryFeed)

    let cached = try cache.read(
      Dispensary.self,
      forKey: dispensary.id.uuidString,
      namespace: .dispensaryFeed
    )
    XCTAssertEqual(cached?.value, dispensary)
  }

  func test_write_thenRead_handlesLocalCartDraft() throws {
    var draft = LocalCartDraft()
    draft.add(
      .init(
        listingId: UUID(),
        productId: UUID(),
        productName: "Vape Cart 0.5g",
        brand: "DankCo",
        priceCents: 4500,
        quantity: 1,
        maxAvailable: 10
      )
    )
    try cache.write(draft, forKey: "current", namespace: .product)

    let cached = try cache.read(LocalCartDraft.self, forKey: "current", namespace: .product)
    XCTAssertEqual(cached?.value, draft)
  }

  // MARK: - Decoding failure surfaces typed error

  func test_read_throwsDecodingFailedWhenFileIsCorrupt() throws {
    let namespaceURL = directory.appendingPathComponent(
      CatalogCache.Namespace.product.rawValue,
      isDirectory: true
    )
    try FileManager.default.createDirectory(at: namespaceURL, withIntermediateDirectories: true)
    let fileURL = namespaceURL.appendingPathComponent("bad.json")
    try Data("{ not valid json".utf8).write(to: fileURL)

    XCTAssertThrowsError(
      try cache.read(SamplePayload.self, forKey: "bad", namespace: .product)
    ) { error in
      guard case CatalogCacheError.decodingFailed = error else {
        return XCTFail("Expected .decodingFailed, got \(error)")
      }
    }
  }
}

// MARK: - Fixtures

private struct SamplePayload: Codable, Equatable, Sendable {
  let name: String
  let priceCents: Int
}

private func sampleDispensary() -> Dispensary {
  Dispensary(
    id: UUID(uuidString: "00000000-0000-0000-0000-000000000001")!,
    legalName: "Nokomis Cannabis Co.",
    dba: "Nokomis Co.",
    licenseNumber: "MN-RET-0001",
    licenseType: .retailer,
    addressLine1: "1100 Hennepin Ave",
    addressLine2: nil,
    city: "Minneapolis",
    region: "MN",
    postalCode: "55403",
    location: Coordinate(latitude: 44.9778, longitude: -93.2650),
    deliveryPolygon: GeoPolygon(rings: [[
      Coordinate(latitude: 44.97, longitude: -93.27),
      Coordinate(latitude: 44.98, longitude: -93.27),
      Coordinate(latitude: 44.98, longitude: -93.26),
      Coordinate(latitude: 44.97, longitude: -93.26),
      Coordinate(latitude: 44.97, longitude: -93.27),
    ]]),
    hours: DispensaryHours(
      mon: DayHours(openMinutes: 8 * 60, closeMinutes: 22 * 60),
      tue: DayHours(openMinutes: 8 * 60, closeMinutes: 22 * 60),
      wed: DayHours(openMinutes: 8 * 60, closeMinutes: 22 * 60),
      thu: DayHours(openMinutes: 8 * 60, closeMinutes: 22 * 60),
      fri: DayHours(openMinutes: 8 * 60, closeMinutes: 22 * 60),
      sat: DayHours(openMinutes: 10 * 60, closeMinutes: 22 * 60),
      sun: nil
    ),
    phone: "+16125551212",
    email: nil,
    logoImageKey: nil,
    heroImageKey: nil,
    brandColorHex: "#1E8E3E",
    isAcceptingOrders: true,
    isOpenNow: true,
    opensAt: nil,
    ratingAvg: Decimal(string: "4.50"),
    ratingCount: 12,
    status: .active,
    createdAt: Date(timeIntervalSince1970: 1_700_000_000),
    updatedAt: Date(timeIntervalSince1970: 1_700_000_500)
  )
}
