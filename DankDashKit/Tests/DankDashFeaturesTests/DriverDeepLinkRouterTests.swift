import XCTest
import DankDashFeatures

/// Mirror of ``DeepLinkRouterTests`` for the driver-app router. The
/// router is a pure URL→enum parser; every malformed input collapses to
/// `nil` so the caller treats it as a no-op (the way
/// ``DankDasherApp/onOpenURL`` is wired).
final class DriverDeepLinkRouterTests: XCTestCase {

  func test_offer_parsesValidUUIDFromHostPath() {
    let id = UUID(uuidString: "11111111-2222-3333-4444-555555555555")!
    let url = URL(string: "dankdasher://offer/\(id.uuidString)")!

    XCTAssertEqual(DriverDeepLinkRouter.route(url), .offer(orderId: id))
  }

  func test_offer_isCaseInsensitiveOnSchemeAndHost() {
    let id = UUID()
    let url = URL(string: "DankDasher://Offer/\(id.uuidString)")!

    XCTAssertEqual(DriverDeepLinkRouter.route(url), .offer(orderId: id))
  }

  func test_offer_acceptsUppercaseUUID() {
    let id = UUID()
    let url = URL(string: "dankdasher://offer/\(id.uuidString.uppercased())")!

    XCTAssertEqual(DriverDeepLinkRouter.route(url), .offer(orderId: id))
  }

  func test_offer_returnsNil_whenPathMissing() {
    let url = URL(string: "dankdasher://offer")!
    XCTAssertNil(DriverDeepLinkRouter.route(url))
  }

  func test_offer_returnsNil_whenPathEmpty() {
    let url = URL(string: "dankdasher://offer/")!
    XCTAssertNil(DriverDeepLinkRouter.route(url))
  }

  func test_offer_returnsNil_whenUUIDMalformed() {
    let url = URL(string: "dankdasher://offer/not-a-uuid")!
    XCTAssertNil(DriverDeepLinkRouter.route(url))
  }

  func test_returnsNil_forWrongScheme() {
    let id = UUID()
    let url = URL(string: "dankdash://offer/\(id.uuidString)")!
    XCTAssertNil(DriverDeepLinkRouter.route(url))
  }

  func test_returnsNil_forHTTPSScheme() {
    let id = UUID()
    let url = URL(string: "https://driver.dankdash.com/offer/\(id.uuidString)")!
    XCTAssertNil(DriverDeepLinkRouter.route(url))
  }

  func test_returnsNil_forUnknownHost() {
    let id = UUID()
    let url = URL(string: "dankdasher://route/\(id.uuidString)")!
    XCTAssertNil(DriverDeepLinkRouter.route(url))
  }

  func test_picksFirstPathSegment_whenTrailingSegmentsArePresent() {
    let id = UUID()
    let url = URL(string: "dankdasher://offer/\(id.uuidString)/details")!
    XCTAssertEqual(DriverDeepLinkRouter.route(url), .offer(orderId: id))
  }
}
