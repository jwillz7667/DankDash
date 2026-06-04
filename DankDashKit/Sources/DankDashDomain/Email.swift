import Foundation

/// Validated email wrapper. Construction fails for inputs that don't look
/// like an addressable mailbox; the rule is intentionally narrow (single
/// `@`, dot in the host) rather than full RFC 5322 — the server is the
/// authority on what's accepted, the client just stops obvious typos.
public struct Email: Hashable, Sendable {
  public let rawValue: String

  public init?(_ rawValue: String) {
    let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard Email.isValid(trimmed) else { return nil }
    self.rawValue = trimmed
  }

  public static func isValid(_ candidate: String) -> Bool {
    guard candidate.count <= 254, !candidate.isEmpty else { return false }
    let parts = candidate.split(separator: "@", omittingEmptySubsequences: false)
    guard parts.count == 2 else { return false }
    let local = parts[0]
    let host = parts[1]
    guard !local.isEmpty, !host.isEmpty else { return false }
    guard host.contains(".") else { return false }
    guard !host.hasPrefix("."), !host.hasSuffix(".") else { return false }
    return candidate.allSatisfy { ch in
      ch.isLetter || ch.isNumber || "._%+-@".contains(ch)
    }
  }
}

extension Email: Codable {
  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    let raw = try container.decode(String.self)
    guard let email = Email(raw) else {
      throw DecodingError.dataCorruptedError(
        in: container,
        debugDescription: "Invalid email: \(raw)"
      )
    }
    self = email
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }
}

extension Email: CustomStringConvertible {
  public var description: String { rawValue }
}
