import XCTest
@testable import DankDashDomain

final class ModuleTests: XCTestCase {
  func test_moduleNameIsStable() {
    XCTAssertEqual(DankDashDomain.moduleName, "DankDashDomain")
  }
}
