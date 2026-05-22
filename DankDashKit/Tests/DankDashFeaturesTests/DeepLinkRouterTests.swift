import XCTest
import DankDashFeatures

final class DeepLinkRouterTests: XCTestCase {
  func test_orderComplete_parsesValidUUID() {
    let id = UUID(uuidString: "11111111-2222-3333-4444-555555555555")!
    let url = URL(string: "dankdash://order/complete?orderId=\(id.uuidString)")!

    XCTAssertEqual(DeepLinkRouter.route(url), .orderComplete(orderId: id))
  }

  func test_orderComplete_isCaseInsensitiveOnSchemeAndHost() {
    let id = UUID()
    let url = URL(string: "DankDash://Order/complete?orderId=\(id.uuidString)")!

    XCTAssertEqual(DeepLinkRouter.route(url), .orderComplete(orderId: id))
  }

  func test_orderComplete_returnsNil_whenOrderIdMissing() {
    let url = URL(string: "dankdash://order/complete")!
    XCTAssertNil(DeepLinkRouter.route(url))
  }

  func test_orderComplete_returnsNil_whenOrderIdEmpty() {
    let url = URL(string: "dankdash://order/complete?orderId=")!
    XCTAssertNil(DeepLinkRouter.route(url))
  }

  func test_orderComplete_returnsNil_whenOrderIdMalformed() {
    let url = URL(string: "dankdash://order/complete?orderId=not-a-uuid")!
    XCTAssertNil(DeepLinkRouter.route(url))
  }

  func test_returnsNil_forWrongScheme() {
    let id = UUID()
    let url = URL(string: "https://app.dankdash.com/order/complete?orderId=\(id.uuidString)")!
    XCTAssertNil(DeepLinkRouter.route(url))
  }

  func test_returnsNil_forUnknownHost() {
    let id = UUID()
    let url = URL(string: "dankdash://payment/complete?orderId=\(id.uuidString)")!
    XCTAssertNil(DeepLinkRouter.route(url))
  }

  func test_returnsNil_forUnknownPath() {
    let id = UUID()
    let url = URL(string: "dankdash://order/started?orderId=\(id.uuidString)")!
    XCTAssertNil(DeepLinkRouter.route(url))
  }

  func test_returnsNil_forHostWithEmptyPath() {
    let id = UUID()
    let url = URL(string: "dankdash://order?orderId=\(id.uuidString)")!
    XCTAssertNil(DeepLinkRouter.route(url))
  }

  func test_returnsNil_whenAuxiliaryQueryParamsArePresent_butOrderIdMissing() {
    let url = URL(string: "dankdash://order/complete?utm_source=mail")!
    XCTAssertNil(DeepLinkRouter.route(url))
  }

  func test_picksOrderId_whenMultipleQueryItemsArePresent() {
    let id = UUID()
    let url = URL(string: "dankdash://order/complete?utm=mail&orderId=\(id.uuidString)&ref=app")!
    XCTAssertEqual(DeepLinkRouter.route(url), .orderComplete(orderId: id))
  }
}
