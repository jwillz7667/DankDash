import XCTest
@testable import DankDashNetwork

final class ModuleTests: XCTestCase {
  func test_moduleNameIsStable() {
    XCTAssertEqual(DankDashNetwork.moduleName, "DankDashNetwork")
  }
}
