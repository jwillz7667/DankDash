import Foundation

public enum Weekday: Int, Hashable, Sendable, CaseIterable, Codable {
  case monday = 0
  case tuesday
  case wednesday
  case thursday
  case friday
  case saturday
  case sunday
}

/// A daily open/close window. Both values are minutes-past-local-midnight
/// of the day they're keyed under in `DispensaryHours`. Values >= 24*60
/// encode a close that falls on the next calendar day — a store that
/// closes at 02:00 the following morning encodes `closeMinutes = 26*60`
/// (matches the server's `HH:MM` regex allowing hours up to 30).
public struct DayHours: Hashable, Sendable, Codable {
  public let openMinutes: Int
  public let closeMinutes: Int

  public init(openMinutes: Int, closeMinutes: Int) {
    self.openMinutes = openMinutes
    self.closeMinutes = closeMinutes
  }

  /// Parses two `HH:MM` strings as they appear on the wire. `HH` accepts
  /// `00`..`30` so next-day close encoding round-trips.
  public init?(open: String, close: String) {
    guard let o = DayHours.parseHHMM(open), let c = DayHours.parseHHMM(close) else {
      return nil
    }
    self.openMinutes = o
    self.closeMinutes = c
  }

  /// Reverse of `init(open:close:)`. Always emits 5-character `HH:MM`
  /// with leading zeros, hours up to `30`.
  public var openHHMM: String { DayHours.formatHHMM(openMinutes) }
  public var closeHHMM: String { DayHours.formatHHMM(closeMinutes) }

  private static func parseHHMM(_ s: String) -> Int? {
    let parts = s.split(separator: ":", omittingEmptySubsequences: false)
    guard parts.count == 2 else { return nil }
    guard let h = Int(parts[0]), let m = Int(parts[1]) else { return nil }
    guard (0...30).contains(h), (0...59).contains(m) else { return nil }
    return h * 60 + m
  }

  private static func formatHHMM(_ minutes: Int) -> String {
    let h = minutes / 60
    let m = minutes % 60
    return String(format: "%02d:%02d", h, m)
  }
}

/// Weekly hours for a dispensary. `nil` means the store is closed all day
/// that weekday. The server is authoritative on whether the store is open
/// right now (`Dispensary.isOpenNow`); this Domain type only re-derives
/// open-state from cached responses where the server flag has gone stale.
public struct DispensaryHours: Hashable, Sendable, Codable {
  public let mon: DayHours?
  public let tue: DayHours?
  public let wed: DayHours?
  public let thu: DayHours?
  public let fri: DayHours?
  public let sat: DayHours?
  public let sun: DayHours?

  public init(
    mon: DayHours?,
    tue: DayHours?,
    wed: DayHours?,
    thu: DayHours?,
    fri: DayHours?,
    sat: DayHours?,
    sun: DayHours?
  ) {
    self.mon = mon
    self.tue = tue
    self.wed = wed
    self.thu = thu
    self.fri = fri
    self.sat = sat
    self.sun = sun
  }

  public subscript(day: Weekday) -> DayHours? {
    switch day {
    case .monday: mon
    case .tuesday: tue
    case .wednesday: wed
    case .thursday: thu
    case .friday: fri
    case .saturday: sat
    case .sunday: sun
    }
  }

  /// Re-derives the open/closed state of the dispensary at `reference`.
  /// Defaults to America/Chicago so the boundary matches how the server's
  /// compliance engine resolves sale hours. Returns `true` if either:
  ///
  ///   1. The reference falls inside today's window `[open, close)`.
  ///   2. Yesterday's window wrapped past local midnight (close > 24:00)
  ///      and the reference falls inside the wrapped portion.
  public func isOpen(
    asOf reference: Date,
    timeZone: TimeZone = TimeZone(identifier: "America/Chicago") ?? .gmt
  ) -> Bool {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = timeZone

    let todayMidnight = cal.startOfDay(for: reference)
    guard let yesterdayMidnight = cal.date(byAdding: .day, value: -1, to: todayMidnight) else {
      return false
    }

    let today = weekday(for: todayMidnight, in: cal)
    let yesterday = weekday(for: yesterdayMidnight, in: cal)

    if let hours = self[today],
       let openAt = cal.date(byAdding: .minute, value: hours.openMinutes, to: todayMidnight),
       let closeAt = cal.date(byAdding: .minute, value: hours.closeMinutes, to: todayMidnight),
       reference >= openAt, reference < closeAt {
      return true
    }

    if let hours = self[yesterday], hours.closeMinutes > 24 * 60,
       let openAt = cal.date(byAdding: .minute, value: hours.openMinutes, to: yesterdayMidnight),
       let closeAt = cal.date(byAdding: .minute, value: hours.closeMinutes, to: yesterdayMidnight),
       reference >= openAt, reference < closeAt {
      return true
    }

    return false
  }

  private func weekday(for date: Date, in calendar: Calendar) -> Weekday {
    let component = calendar.component(.weekday, from: date)
    return switch component {
    case 1: .sunday
    case 2: .monday
    case 3: .tuesday
    case 4: .wednesday
    case 5: .thursday
    case 6: .friday
    case 7: .saturday
    default: .sunday
    }
  }
}
