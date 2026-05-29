import XCTest
@testable import DankDashStorage

/// Each test instantiates its own `UserDefaults` suite so parallel
/// runs never collide and a leaked write from one test cannot pollute
/// the next.
final class DriverSessionStoreTests: XCTestCase {
  private var suiteName: String!
  private var defaults: UserDefaults!
  private var store: DriverSessionStore!

  override func setUp() {
    super.setUp()
    suiteName = "DankDasherSessionTests-\(UUID().uuidString)"
    defaults = UserDefaults(suiteName: suiteName)
    defaults.removePersistentDomain(forName: suiteName)
    store = DriverSessionStore(suiteName: suiteName)
  }

  override func tearDown() {
    defaults.removePersistentDomain(forName: suiteName)
    store = nil
    defaults = nil
    suiteName = nil
    super.tearDown()
  }

  // MARK: - Round-trip

  func test_writeSnapshot_thenRead_returnsExactlyWhatWasWritten() {
    let snapshot = DriverSessionStore.Snapshot(
      shiftId: UUID(),
      startedAt: Date(timeIntervalSince1970: 1_700_000_000),
      lastKnownLocationLat: 44.9778,
      lastKnownLocationLng: -93.2650,
      lastHeartbeatAt: Date(timeIntervalSince1970: 1_700_000_090)
    )
    store.write(snapshot)
    XCTAssertEqual(store.read(), snapshot)
  }

  func test_read_returnsNilWhenAbsent() {
    XCTAssertNil(store.read())
  }

  func test_write_overwritesPrevious() {
    let first = DriverSessionStore.Snapshot(
      shiftId: UUID(),
      startedAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
    let second = DriverSessionStore.Snapshot(
      shiftId: UUID(),
      startedAt: Date(timeIntervalSince1970: 1_700_001_000)
    )
    store.write(first)
    store.write(second)

    XCTAssertEqual(store.read()?.shiftId, second.shiftId)
  }

  // MARK: - Heartbeat updates

  func test_updateHeartbeat_mutatesLocationAndHeartbeat() {
    let original = DriverSessionStore.Snapshot(
      shiftId: UUID(),
      startedAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
    store.write(original)

    let beat = Date(timeIntervalSince1970: 1_700_000_090)
    store.updateHeartbeat(lat: 44.9778, lng: -93.2650, at: beat)

    let read = store.read()
    XCTAssertEqual(read?.shiftId, original.shiftId)
    XCTAssertEqual(read?.startedAt, original.startedAt)
    XCTAssertEqual(read?.lastKnownLocationLat, 44.9778)
    XCTAssertEqual(read?.lastKnownLocationLng, -93.2650)
    XCTAssertEqual(read?.lastHeartbeatAt, beat)
  }

  func test_updateHeartbeat_preservesPreviousCoordinateWhenNilProvided() {
    let original = DriverSessionStore.Snapshot(
      shiftId: UUID(),
      startedAt: Date(timeIntervalSince1970: 1_700_000_000),
      lastKnownLocationLat: 44.9778,
      lastKnownLocationLng: -93.2650
    )
    store.write(original)

    let beat = Date(timeIntervalSince1970: 1_700_000_090)
    store.updateHeartbeat(lat: nil, lng: nil, at: beat)

    let read = store.read()
    XCTAssertEqual(read?.lastKnownLocationLat, 44.9778)
    XCTAssertEqual(read?.lastKnownLocationLng, -93.2650)
    XCTAssertEqual(read?.lastHeartbeatAt, beat)
  }

  func test_updateHeartbeat_isNoopWhenNoSnapshot() {
    XCTAssertNil(store.read())
    store.updateHeartbeat(lat: 1, lng: 2, at: Date())
    XCTAssertNil(store.read(), "no snapshot means no write")
  }

  // MARK: - Clear

  func test_clear_removesSnapshot() {
    store.write(
      DriverSessionStore.Snapshot(
        shiftId: UUID(),
        startedAt: Date(timeIntervalSince1970: 1_700_000_000)
      )
    )
    store.clear()
    XCTAssertNil(store.read())
  }

  func test_clear_isIdempotent() {
    store.clear()
    store.clear()
    XCTAssertNil(store.read())
  }

  // MARK: - Corrupt payload

  func test_read_returnsNilWhenStoredDataIsNotValidJSON() {
    defaults.set(Data("{ not valid json".utf8), forKey: "dankdasher.session.activeShift")
    XCTAssertNil(store.read(), "corrupt payload is treated as absent — reducer recalls /v1/driver/me")
  }
}
