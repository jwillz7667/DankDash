import XCTest
@testable import DankDashFeatures

final class ModuleTests: XCTestCase {
  func test_moduleNameIsStable() {
    XCTAssertEqual(DankDashFeatures.moduleName, "DankDashFeatures")
  }
}
