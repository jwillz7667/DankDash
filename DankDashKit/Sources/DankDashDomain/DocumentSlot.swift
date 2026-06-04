import Foundation

/// The three required document uploads for driver onboarding. The slot
/// is the local-only identifier used by ``DriverApplicationDraft`` and
/// the document-upload UI; when the backend presigned-URL endpoint
/// lands, the slot maps to a server-side `document_kind` column.
public enum DocumentSlot: String, Hashable, Sendable, CaseIterable, Codable {
  case driversLicense = "drivers_license"
  case vehicleInsurance = "vehicle_insurance"
  case vehicleRegistration = "vehicle_registration"

  /// User-facing label for the upload row.
  public var displayLabel: String {
    switch self {
    case .driversLicense: "Driver's license"
    case .vehicleInsurance: "Vehicle insurance"
    case .vehicleRegistration: "Vehicle registration"
    }
  }

  /// Short helper copy under the row name explaining what the
  /// document is.
  public var helperText: String {
    switch self {
    case .driversLicense: "Valid Minnesota driver's license, front side"
    case .vehicleInsurance: "Current proof of insurance — declarations page"
    case .vehicleRegistration: "Most recent vehicle registration certificate"
    }
  }
}
