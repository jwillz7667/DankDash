import Foundation

/// Customer-facing fields the driver sees at the dropoff. The consumer's
/// last name is shipped separately so the UI can render initials
/// ("Sam J.") rather than the full surname — fewer surfaces leaking PII
/// to the dispatched driver. `maskedPhone` is `***-***-1234` form; tap
/// to call routes through Twilio Proxy in a later phase so the raw
/// number never reaches the driver's device.
///
/// All fields are nullable to mirror the server contract — a phone-less
/// account or a consumer who created their order before requiring a
/// name should not block a delivery.
public struct DriverHandoffCustomer: Sendable, Equatable, Hashable, Codable {
  public let firstName: String?
  public let lastName: String?
  public let maskedPhone: String?

  public init(firstName: String?, lastName: String?, maskedPhone: String?) {
    self.firstName = firstName
    self.lastName = lastName
    self.maskedPhone = maskedPhone
  }

  /// Display name with the surname collapsed to a single initial —
  /// `Sam J.` for `firstName="Sam"`, `lastName="Johnson"`. Returns
  /// `firstName` alone when no surname; returns "Customer" if both are
  /// missing so the UI always has something to render.
  public var displayName: String {
    let firstTrim = firstName?.trimmingCharacters(in: .whitespacesAndNewlines)
    let lastTrim = lastName?.trimmingCharacters(in: .whitespacesAndNewlines)
    switch (firstTrim, lastTrim) {
    case let (first?, last?) where !first.isEmpty && !last.isEmpty:
      return "\(first) \(last.prefix(1))."
    case let (first?, _) where !first.isEmpty:
      return first
    case let (_, last?) where !last.isEmpty:
      return last
    default:
      return "Customer"
    }
  }
}
