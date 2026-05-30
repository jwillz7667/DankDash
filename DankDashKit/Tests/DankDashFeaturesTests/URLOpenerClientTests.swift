import XCTest
import Foundation
@testable import DankDashFeatures

final class URLOpenerClientTests: XCTestCase {
  func test_unimplemented_returnsFalse() async {
    let client = URLOpenerClient.unimplemented
    let url = URL(string: "dankdash://order/complete?orderId=abc")!
    let ok = await client.open(url)
    XCTAssertFalse(ok)
  }

  func test_customClient_recordsURL() async {
    let recorder = URLRecorder()
    let client = URLOpenerClient(
      open: { url in
        await recorder.record(url)
        return true
      }
    )
    let url = URL(string: "https://app.dankdash.com/checkout?handoff=tok")!
    let ok = await client.open(url)
    let received = await recorder.opened
    XCTAssertTrue(ok)
    XCTAssertEqual(received, [url])
  }

  func test_customClient_canSimulateFailure() async {
    let client = URLOpenerClient(open: { _ in false })
    let ok = await client.open(URL(string: "dankdash://")!)
    XCTAssertFalse(ok)
  }
}

private actor URLRecorder {
  var opened: [URL] = []
  func record(_ url: URL) { opened.append(url) }
}
