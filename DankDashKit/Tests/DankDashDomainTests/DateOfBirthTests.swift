import XCTest
@testable import DankDashDomain

final class DateOfBirthTests: XCTestCase {
  func test_constructsValidCalendarDate() {
    XCTAssertNotNil(DateOfBirth(year: 2000, month: 1, day: 1))
    XCTAssertNotNil(DateOfBirth(year: 2024, month: 2, day: 29))  // leap day
    XCTAssertNotNil(DateOfBirth(year: 1985, month: 12, day: 31))
  }

  func test_rejectsImpossibleCalendarDates() {
    XCTAssertNil(DateOfBirth(year: 2023, month: 2, day: 29))  // not a leap year
    XCTAssertNil(DateOfBirth(year: 2024, month: 13, day: 1))
    XCTAssertNil(DateOfBirth(year: 2024, month: 4, day: 31))
    XCTAssertNil(DateOfBirth(year: 2024, month: 0, day: 1))
    XCTAssertNil(DateOfBirth(year: 1899, month: 1, day: 1))   // unreasonable range
  }

  func test_parsesISO8601() {
    let dob = DateOfBirth(iso8601: "2000-01-15")
    XCTAssertEqual(dob?.year, 2000)
    XCTAssertEqual(dob?.month, 1)
    XCTAssertEqual(dob?.day, 15)
  }

  func test_rejectsISO8601MalformedInput() {
    XCTAssertNil(DateOfBirth(iso8601: ""))
    XCTAssertNil(DateOfBirth(iso8601: "2000-1-1"))         // no zero-pad
    XCTAssertNil(DateOfBirth(iso8601: "2000-01-32"))       // invalid day
    XCTAssertNil(DateOfBirth(iso8601: "2000/01/01"))       // wrong separator
    XCTAssertNil(DateOfBirth(iso8601: "20000-01-01"))      // 5-digit year
  }

  func test_iso8601RoundTrip() {
    let dob = DateOfBirth(year: 2003, month: 7, day: 4)!
    XCTAssertEqual(dob.iso8601, "2003-07-04")
    XCTAssertEqual(DateOfBirth(iso8601: dob.iso8601), dob)
  }

  func test_codableEmitsString() throws {
    let dob = DateOfBirth(year: 1999, month: 11, day: 12)!
    let data = try JSONEncoder().encode(dob)
    let str = String(data: data, encoding: .utf8)
    XCTAssertEqual(str, #""1999-11-12""#)
    let back = try JSONDecoder().decode(DateOfBirth.self, from: data)
    XCTAssertEqual(back, dob)
  }

  // MARK: - 21+ predicate

  private func makeCentralDate(year: Int, month: Int, day: Int, hour: Int = 12) -> Date {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone(identifier: "America/Chicago")!
    return cal.date(from: DateComponents(year: year, month: month, day: day, hour: hour))!
  }

  func test_isOver21_onExact21stBirthday_passes() {
    let dob = DateOfBirth(year: 2005, month: 6, day: 1)!
    let reference = makeCentralDate(year: 2026, month: 6, day: 1)
    XCTAssertTrue(dob.isOver21(asOf: reference))
  }

  func test_isOver21_dayBefore21stBirthday_fails() {
    let dob = DateOfBirth(year: 2005, month: 6, day: 2)!
    let reference = makeCentralDate(year: 2026, month: 6, day: 1)
    XCTAssertFalse(dob.isOver21(asOf: reference))
  }

  func test_isOver21_wellOver21_passes() {
    let dob = DateOfBirth(year: 1980, month: 1, day: 1)!
    let reference = makeCentralDate(year: 2026, month: 5, day: 20)
    XCTAssertTrue(dob.isOver21(asOf: reference))
  }

  func test_isOver21_clearlyUnder21_fails() {
    let dob = DateOfBirth(year: 2010, month: 5, day: 20)!
    let reference = makeCentralDate(year: 2026, month: 5, day: 20)
    XCTAssertFalse(dob.isOver21(asOf: reference))
  }

  func test_isOver21_acrossDSTSpringForward_remainsStable() {
    // 2026-03-08 is the U.S. spring-forward day. If we naively computed
    // age by dividing seconds, a 21-year span containing 21 spring-forwards
    // could be one second short and trip a boundary. We use calendar
    // year-deltas so this is immune.
    let dob = DateOfBirth(year: 2005, month: 3, day: 8)!
    let reference = makeCentralDate(year: 2026, month: 3, day: 8, hour: 1)
    XCTAssertTrue(dob.isOver21(asOf: reference))
  }
}
