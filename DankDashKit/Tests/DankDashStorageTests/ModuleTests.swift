import XCTest
@testable import DankDashStorage

final class ModuleTests: XCTestCase {
  func test_moduleNameIsStable() {
    XCTAssertEqual(DankDashStorage.moduleName, "DankDashStorage")
  }
}
