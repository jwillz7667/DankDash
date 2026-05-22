import XCTest
@testable import DankDashDomain

/// ``EarningsPeriod`` is part of the URL query string on `?period=`. The
/// raw values are a wire contract — a rename would silently change
/// which bucket the server returns.
final class EarningsPeriodTests: XCTestCase {
  func test_rawValuesMatchQueryString() {
    XCTAssertEqual(EarningsPeriod.today.rawValue, "today")
    XCTAssertEqual(EarningsPeriod.week.rawValue, "week")
    XCTAssertEqual(EarningsPeriod.month.rawValue, "month")
  }

  func test_queryValueMatchesRawValue() {
    for period in EarningsPeriod.allCases {
      XCTAssertEqual(period.queryValue, period.rawValue)
    }
  }

  func test_allCasesCountIsThree() {
    XCTAssertEqual(EarningsPeriod.allCases.count, 3)
  }

  func test_displayLabelNonEmptyForEveryCase() {
    for period in EarningsPeriod.allCases {
      XCTAssertFalse(period.displayLabel.isEmpty, "\(period) displayLabel empty")
    }
  }
}
