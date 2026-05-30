import Foundation

/// In-progress driver application held locally by the onboarding
/// reducer and persisted between launches by
/// ``DriverApplicationDraftStore``. Once the backend
/// `POST /v1/driver/applications` endpoint is built, the reducer
/// submits this entire payload; until then the draft persists locally
/// and surfaces a "queued — admin will reach out" state.
///
/// `licenseNumber` is the driver's plain-text license number; it stays
/// on-device until submission and is never written to telemetry, logs,
/// or analytics. The store encrypts the draft file with the
/// device-bound data-protection class (afterFirstUnlock).
///
/// `documents` is a slot → draft document map; the four cases of
/// ``DocumentSlot`` map to at most four uploads (one per slot — newer
/// uploads replace older ones for the same slot rather than
/// accumulating).
public struct DriverApplicationDraft: Hashable, Sendable, Codable {
  public let id: UUID
  public var vehicle: Vehicle
  public var licenseNumber: String
  public var documents: [DocumentSlot: DraftDocument]
  public let createdAt: Date
  public var updatedAt: Date

  public init(
    id: UUID = UUID(),
    vehicle: Vehicle = Vehicle(),
    licenseNumber: String = "",
    documents: [DocumentSlot: DraftDocument] = [:],
    createdAt: Date = Date(),
    updatedAt: Date = Date()
  ) {
    self.id = id
    self.vehicle = vehicle
    self.licenseNumber = licenseNumber
    self.documents = documents
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }

  /// Field-level validation issues. Empty array means the draft is
  /// ready to submit. The review screen reads this to enable/disable
  /// the "Submit application" button.
  public func validate() -> [ValidationIssue] {
    var issues: [ValidationIssue] = []
    if !vehicle.isComplete {
      issues.append(.vehicleIncomplete)
    }
    if licenseNumber.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      issues.append(.licenseNumberMissing)
    }
    for slot in DocumentSlot.allCases where documents[slot] == nil {
      issues.append(.documentMissing(slot))
    }
    return issues
  }

  /// True when every required field is populated. Equivalent to
  /// `validate().isEmpty`; kept as a one-line predicate for call sites
  /// that don't need the typed issue list.
  public var isReadyToSubmit: Bool {
    validate().isEmpty
  }

  public enum ValidationIssue: Hashable, Sendable, Codable {
    case vehicleIncomplete
    case licenseNumberMissing
    case documentMissing(DocumentSlot)

    public var displayMessage: String {
      switch self {
      case .vehicleIncomplete:
        "Add your vehicle's make, model, year, plate, and color."
      case .licenseNumberMissing:
        "Enter your driver's license number."
      case .documentMissing(let slot):
        "Upload your \(slot.displayLabel.lowercased())."
      }
    }
  }
}
