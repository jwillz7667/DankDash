import Foundation

/// E.164 phone wrapper: `+` followed by 1–15 digits, first digit non-zero.
/// Mirrors the server's `PHONE_E164` regex in `apps/api/.../register.dto.ts`
/// so a value that passes the client check passes the wire check.
public struct Phone: Hashable, Sendable {
  public let rawValue: String

  public init?(_ rawValue: String) {
    let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard Phone.isValid(trimmed) else { return nil }
    self.rawValue = trimmed
  }

  public static func isValid(_ candidate: String) -> Bool {
    guard candidate.hasPrefix("+") else { return false }
    let digits = candidate.dropFirst()
    guard digits.count >= 2, digits.count <= 15 else { return false }
    guard let first = digits.first, ("1"..."9").contains(first) else { return false }
    return digits.allSatisfy { $0.isASCII && $0.isNumber }
  }
}

extension Phone: Codable {
  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    let raw = try container.decode(String.self)
    guard let phone = Phone(raw) else {
      throw DecodingError.dataCorruptedError(
        in: container,
        debugDescription: "Invalid E.164 phone: \(raw)"
      )
    }
    self = phone
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }
}

extension Phone: CustomStringConvertible {
  public var description: String { rawValue }
}
