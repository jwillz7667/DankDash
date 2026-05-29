import Foundation

/// USD money stored as an integer count of cents. Matches the backend
/// convention in `CLAUDE.md` ("Money is NUMERIC(12,2) in the DB and
/// integer cents in code. Never FLOAT. Never JavaScript number for
/// cannabis weights — use decimal.js.") so wire serialization is a
/// trivial integer.
public struct Money: Hashable, Sendable {
  public let cents: Int

  public init(cents: Int) {
    self.cents = cents
  }

  public static let zero = Money(cents: 0)

  public var dollars: Decimal {
    Decimal(cents) / 100
  }

  /// Locale-aware "$12.34" rendering. Defaults to US locale because the
  /// product ships in MN only at launch; passing a Locale override is
  /// here for the design gallery's right-to-left preview.
  public func formatted(
    currencyCode: String = "USD",
    locale: Locale = Locale(identifier: "en_US")
  ) -> String {
    var fmt = Decimal.FormatStyle.Currency(code: currencyCode, locale: locale)
    fmt.locale = locale
    return dollars.formatted(fmt)
  }

  public static func + (lhs: Money, rhs: Money) -> Money {
    Money(cents: lhs.cents + rhs.cents)
  }

  public static func - (lhs: Money, rhs: Money) -> Money {
    Money(cents: lhs.cents - rhs.cents)
  }

  public static func * (lhs: Money, rhs: Int) -> Money {
    Money(cents: lhs.cents * rhs)
  }
}

extension Money: Comparable {
  public static func < (lhs: Money, rhs: Money) -> Bool {
    lhs.cents < rhs.cents
  }
}

extension Money: Codable {
  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    let cents = try container.decode(Int.self)
    self.init(cents: cents)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(cents)
  }
}

extension Money: CustomStringConvertible {
  public var description: String { formatted() }
}
