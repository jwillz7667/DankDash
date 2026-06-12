import XCTest
@testable import DankDashStorage

final class SessionTokenCacheTests: XCTestCase {
  func test_setThenRead_roundTrips() async {
    let cache = SessionTokenCache()
    await cache.setRefreshToken("refresh.opaque")
    let value = await cache.currentRefreshToken()
    XCTAssertEqual(value, "refresh.opaque")
  }

  func test_startsEmpty_andClearEmpties() async {
    let cache = SessionTokenCache()
    let initial = await cache.currentRefreshToken()
    XCTAssertNil(initial)

    await cache.setRefreshToken("refresh.opaque")
    await cache.clear()
    let afterClear = await cache.currentRefreshToken()
    XCTAssertNil(afterClear)
  }

  func test_setNil_clears() async {
    let cache = SessionTokenCache()
    await cache.setRefreshToken("refresh.opaque")
    await cache.setRefreshToken(nil)
    let value = await cache.currentRefreshToken()
    XCTAssertNil(value)
  }
}
