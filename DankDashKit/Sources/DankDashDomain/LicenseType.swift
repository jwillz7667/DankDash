import Foundation

/// MN cannabis license categories. Matches the server's `license_type`
/// enum verbatim — the raw values are the wire form. Cosmetic display
/// labels are not embedded here; views format them via a switch so a
/// regulator-mandated rename surfaces as a compile error.
public enum LicenseType: String, Hashable, Sendable, CaseIterable, Codable {
  case retailer
  case microbusiness
  case mezzobusiness
  case medicalCombo = "medical_combo"
  case deliveryService = "delivery_service"
  case lpheRetailer = "lphe_retailer"
}
