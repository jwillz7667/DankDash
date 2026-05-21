import Foundation

/// Frozen snapshot of the dropoff address as seen by the driver. This
/// is the value the driver navigates to and reads aloud at handoff —
/// captured at checkout from `user_addresses` and persisted on
/// `orders.delivery_address_snapshot` so a later edit on the saved
/// address cannot retroactively change the driver's drop.
///
/// `instructions` is the consumer's free-text note ("ring buzzer 4B,
/// leave at door if no answer"). Apartment / suite / floor information
/// rides on `line2`; the schema does not split it further.
public struct DriverHandoffAddress: Sendable, Equatable, Hashable, Codable {
  public let line1: String
  public let line2: String?
  public let city: String
  public let region: String
  public let postalCode: String
  public let location: Coordinate
  public let instructions: String?

  public init(
    line1: String,
    line2: String?,
    city: String,
    region: String,
    postalCode: String,
    location: Coordinate,
    instructions: String?
  ) {
    self.line1 = line1
    self.line2 = line2
    self.city = city
    self.region = region
    self.postalCode = postalCode
    self.location = location
    self.instructions = instructions
  }

  public var oneLine: String {
    var parts: [String] = [line1]
    if let line2 = line2?.trimmingCharacters(in: .whitespacesAndNewlines), !line2.isEmpty {
      parts.append(line2)
    }
    parts.append("\(city), \(region) \(postalCode)")
    return parts.joined(separator: ", ")
  }
}
