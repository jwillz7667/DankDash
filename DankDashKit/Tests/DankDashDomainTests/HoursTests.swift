import XCTest
@testable import DankDashDomain

final class HoursTests: XCTestCase {
  private let chicago = TimeZone(identifier: "America/Chicago")!

  private func makeChicago(_ components: DateComponents) -> Date {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = chicago
    return cal.date(from: components)!
  }

  // MARK: - DayHours parsing

  func test_dayHoursParsesHHMM() {
    let h = DayHours(open: "09:00", close: "21:30")
    XCTAssertEqual(h?.openMinutes, 9 * 60)
    XCTAssertEqual(h?.closeMinutes, 21 * 60 + 30)
  }

  func test_dayHoursAcceptsNextDayCloseEncoding() {
    let h = DayHours(open: "10:00", close: "26:00")  // closes 2am next day
    XCTAssertEqual(h?.openMinutes, 600)
    XCTAssertEqual(h?.closeMinutes, 1560)
  }

  func test_dayHoursAcceptsSingleDigitHour() {
    // Server regex `^([0-2]?\d|30):[0-5]\d$` allows single-digit hours.
    let h = DayHours(open: "9:00", close: "21:00")
    XCTAssertEqual(h?.openMinutes, 540)
    XCTAssertEqual(h?.closeMinutes, 1260)
  }

  func test_dayHoursRejectsMalformedInput() {
    XCTAssertNil(DayHours(open: "31:00", close: "21:00"))   // hour out of range
    XCTAssertNil(DayHours(open: "10:60", close: "21:00"))   // minute out of range
    XCTAssertNil(DayHours(open: "10:00", close: ""))         // empty
    XCTAssertNil(DayHours(open: "10-00", close: "21:00"))   // wrong separator
    XCTAssertNil(DayHours(open: "10:00:00", close: "21:00")) // too many parts
  }

  func test_dayHoursRoundTripsHHMM() {
    let h = DayHours(openMinutes: 9 * 60 + 30, closeMinutes: 26 * 60)
    XCTAssertEqual(h.openHHMM, "09:30")
    XCTAssertEqual(h.closeHHMM, "26:00")
  }

  // MARK: - DispensaryHours.isOpen

  private func standardHours(_ open: String = "09:00", close: String = "21:00") -> DispensaryHours {
    let day = DayHours(open: open, close: close)
    return DispensaryHours(mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day)
  }

  func test_isOpenInsideTodayWindow() {
    // Wed 2026-03-04 14:00 Chicago — squarely inside 9–21.
    let now = makeChicago(.init(year: 2026, month: 3, day: 4, hour: 14, minute: 0))
    XCTAssertTrue(standardHours().isOpen(asOf: now))
  }

  func test_isOpenAtOpenInstant() {
    let now = makeChicago(.init(year: 2026, month: 3, day: 4, hour: 9, minute: 0))
    XCTAssertTrue(standardHours().isOpen(asOf: now))
  }

  func test_isClosedAtCloseInstant() {
    let now = makeChicago(.init(year: 2026, month: 3, day: 4, hour: 21, minute: 0))
    XCTAssertFalse(standardHours().isOpen(asOf: now))
  }

  func test_isClosedOneMinuteBeforeOpen() {
    let now = makeChicago(.init(year: 2026, month: 3, day: 4, hour: 8, minute: 59))
    XCTAssertFalse(standardHours().isOpen(asOf: now))
  }

  func test_isClosedOnAllNilDay() {
    let closedAllWeek = DispensaryHours(
      mon: nil, tue: nil, wed: nil, thu: nil, fri: nil, sat: nil, sun: nil
    )
    let now = makeChicago(.init(year: 2026, month: 3, day: 4, hour: 14, minute: 0))
    XCTAssertFalse(closedAllWeek.isOpen(asOf: now))
  }

  func test_isOpenViaNextDayWrap() {
    // Mon 2026-03-02 closes at 02:00 Tue. At 01:00 Tue we are still open.
    let monday = DayHours(open: "10:00", close: "26:00")
    let hours = DispensaryHours(
      mon: monday, tue: nil, wed: nil, thu: nil, fri: nil, sat: nil, sun: nil
    )
    let earlyTuesday = makeChicago(.init(year: 2026, month: 3, day: 3, hour: 1, minute: 0))
    XCTAssertTrue(hours.isOpen(asOf: earlyTuesday))
  }

  func test_isClosedAfterNextDayWrap() {
    let monday = DayHours(open: "10:00", close: "26:00")
    let hours = DispensaryHours(
      mon: monday, tue: nil, wed: nil, thu: nil, fri: nil, sat: nil, sun: nil
    )
    // 03:00 Tuesday — past the 02:00 wrap close.
    let tuesday = makeChicago(.init(year: 2026, month: 3, day: 3, hour: 3, minute: 0))
    XCTAssertFalse(hours.isOpen(asOf: tuesday))
  }

  func test_isOpenDuringDSTSpringForward() {
    // 2026 spring-forward in Chicago: 2026-03-08 02:00 → 03:00 jumps an
    // hour. A store open 09:00–21:00 should be open at 14:00 local.
    let now = makeChicago(.init(year: 2026, month: 3, day: 8, hour: 14, minute: 0))
    XCTAssertTrue(standardHours().isOpen(asOf: now))
  }

  func test_isOpenDuringDSTFallBack() {
    // 2026 fall-back in Chicago: 2026-11-01 02:00 → 01:00. A store open
    // 09:00–21:00 is open at 14:00 local. This protects against the
    // local-day calculation collapsing on the doubled hour.
    let now = makeChicago(.init(year: 2026, month: 11, day: 1, hour: 14, minute: 0))
    XCTAssertTrue(standardHours().isOpen(asOf: now))
  }
}
