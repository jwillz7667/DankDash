import Foundation

/// Calendar date of birth (no time component). Wire format is ISO 8601
/// `YYYY-MM-DD`, matching the server's `ISO_DATE` regex.
///
/// The client copy of the 21+ check is *preview only* — per spec §4.7,
/// the server is authoritative on age verification (Persona returns the
/// verified DOB, the server re-derives age from that, and the age gate
/// here only stops a customer from wasting time on a flow they can't
/// complete). All age math uses the Gregorian calendar so iOS Locale
/// quirks (Buddhist calendar, Japanese era reset) can't surprise us.
public struct DateOfBirth: Hashable, Sendable {
  public let year: Int
  public let month: Int
  public let day: Int

  public init?(year: Int, month: Int, day: Int) {
    guard (1900...3000).contains(year) else { return nil }
    guard (1...12).contains(month) else { return nil }
    guard (1...31).contains(day) else { return nil }
    var components = DateComponents()
    components.year = year
    components.month = month
    components.day = day
    let cal = Calendar(identifier: .gregorian)
    // Round-trip the components through Gregorian to reject Feb 30 etc.
    guard let date = cal.date(from: components) else { return nil }
    let normalized = cal.dateComponents([.year, .month, .day], from: date)
    guard normalized.year == year, normalized.month == month, normalized.day == day else {
      return nil
    }
    self.year = year
    self.month = month
    self.day = day
  }

  public init?(iso8601: String) {
    let parts = iso8601.split(separator: "-")
    guard parts.count == 3 else { return nil }
    guard parts[0].count == 4, parts[1].count == 2, parts[2].count == 2 else { return nil }
    guard
      let y = Int(parts[0]),
      let m = Int(parts[1]),
      let d = Int(parts[2])
    else { return nil }
    self.init(year: y, month: m, day: d)
  }

  public var iso8601: String {
    String(format: "%04d-%02d-%02d", year, month, day)
  }

  /// Returns the year-difference between `asOf` and the DOB, calculated in
  /// the Gregorian calendar against the given time zone. A customer who
  /// turns 21 today qualifies; the boundary is the morning of the
  /// birthday in the supplied zone.
  public func ageInYears(asOf reference: Date, timeZone: TimeZone) -> Int {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = timeZone
    let dob = cal.date(from: DateComponents(year: year, month: month, day: day))!
    let components = cal.dateComponents([.year], from: dob, to: reference)
    return components.year ?? 0
  }

  /// MN minimum cannabis purchase age is 21 (Minn. Stat. § 342.27).
  /// Checked against America/Chicago so the boundary is local midnight,
  /// matching how the server's compliance engine resolves it.
  public func isOver21(asOf reference: Date) -> Bool {
    let chicago = TimeZone(identifier: "America/Chicago") ?? .gmt
    return ageInYears(asOf: reference, timeZone: chicago) >= 21
  }
}

extension DateOfBirth: Codable {
  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    let raw = try container.decode(String.self)
    guard let parsed = DateOfBirth(iso8601: raw) else {
      throw DecodingError.dataCorruptedError(
        in: container,
        debugDescription: "Invalid YYYY-MM-DD date of birth: \(raw)"
      )
    }
    self = parsed
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(iso8601)
  }
}
