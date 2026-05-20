import XCTest
@testable import DankDashDesignSystem

final class ModuleTests: XCTestCase {
  func test_moduleNameIsStable() {
    XCTAssertEqual(DankDashDesignSystem.moduleName, "DankDashDesignSystem")
  }
}
