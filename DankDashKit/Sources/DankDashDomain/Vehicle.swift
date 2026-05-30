import Foundation

/// Driver's vehicle. Mirrors the five `vehicle_*` columns on the
/// `drivers` table — every field is nullable on the wire because the
/// admin onboarding write surface lets ops save partial drafts.
///
/// `isComplete` is the onboarding gate: the shift home refuses to open
/// a shift until every field is non-empty. Year is a 4-digit integer;
/// validity range (the backend enforces `1980..=currentYear + 1`) is
/// not duplicated here because the same backend rejects out-of-range
/// values at the boundary.
public struct Vehicle: Hashable, Sendable, Codable {
  public let make: String?
  public let model: String?
  public let year: Int?
  public let plate: String?
  public let color: String?

  public init(
    make: String? = nil,
    model: String? = nil,
    year: Int? = nil,
    plate: String? = nil,
    color: String? = nil
  ) {
    self.make = make
    self.model = model
    self.year = year
    self.plate = plate
    self.color = color
  }

  /// True when every field carries a non-empty value. The onboarding
  /// vehicle-details form's "Continue" button binds to this; the shift
  /// reducer also reads it to gate the online toggle.
  public var isComplete: Bool {
    guard let make, !make.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
    guard let model, !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
    guard year != nil else { return false }
    guard let plate, !plate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
    guard let color, !color.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
    return true
  }

  /// Human-readable summary for the review screen and the public
  /// driver profile ("Blue 2021 Honda Civic"). Returns the joined
  /// fields with non-empty components only; the plate is intentionally
  /// omitted (it's restricted PII; only the dispensary + ops need it).
  public var displaySummary: String? {
    var tokens: [String] = []
    if let color, !color.isEmpty { tokens.append(color) }
    if let year { tokens.append(String(year)) }
    if let make, !make.isEmpty { tokens.append(make) }
    if let model, !model.isEmpty { tokens.append(model) }
    let joined = tokens.joined(separator: " ")
    return joined.isEmpty ? nil : joined
  }
}
