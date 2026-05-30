import Foundation
import DankDashDomain

/// Document attached to a driver application. `kind` is the wire-side
/// document-kind discriminator (matches the iOS `DocumentSlot` raw
/// values: `drivers_license`, `vehicle_insurance`, `vehicle_registration`).
/// `storageKey` is the upload manifest reference that becomes a
/// presigned-URL handle once the presigned-upload endpoint lands; until
/// then it's a sandbox-relative path the reducer materializes via the
/// `DocumentDraftStore`.
public struct DriverApplicationDocumentDTO: Encodable, Sendable, Equatable {
  public let kind: String
  public let storageKey: String
  public let mimeType: String
  public let sizeBytes: Int

  public init(kind: DocumentSlot, storageKey: String, mimeType: String, sizeBytes: Int) {
    self.kind = kind.rawValue
    self.storageKey = storageKey
    self.mimeType = mimeType
    self.sizeBytes = sizeBytes
  }
}

/// Body for `POST /v1/driver/applications`. Phase 19 ships the iOS
/// half; the backend endpoint is documented as deferred. The DTO is
/// future-proofed against the 404-fallback path — on a 404 the iOS
/// reducer surfaces "queued for review", and once the endpoint lands
/// this same DTO is what gets POSTed.
public struct DriverApplicationRequestDTO: Encodable, Sendable, Equatable {
  public let vehicleMake: String
  public let vehicleModel: String
  public let vehicleYear: Int
  public let vehiclePlate: String
  public let vehicleColor: String
  public let licenseNumber: String
  public let documents: [DriverApplicationDocumentDTO]

  public init(
    vehicleMake: String,
    vehicleModel: String,
    vehicleYear: Int,
    vehiclePlate: String,
    vehicleColor: String,
    licenseNumber: String,
    documents: [DriverApplicationDocumentDTO]
  ) {
    self.vehicleMake = vehicleMake
    self.vehicleModel = vehicleModel
    self.vehicleYear = vehicleYear
    self.vehiclePlate = vehiclePlate
    self.vehicleColor = vehicleColor
    self.licenseNumber = licenseNumber
    self.documents = documents
  }
}

public extension DriverApplicationRequestDTO {
  /// Constructs a wire-ready request from an iOS-side draft. Returns
  /// nil if the draft isn't `isReadyToSubmit` — by then the review
  /// screen's "Submit" button should be disabled, so a nil here is a
  /// logic bug worth catching at the boundary.
  static func from(_ draft: DriverApplicationDraft) -> DriverApplicationRequestDTO? {
    guard draft.isReadyToSubmit else { return nil }
    guard
      let make = draft.vehicle.make,
      let model = draft.vehicle.model,
      let year = draft.vehicle.year,
      let plate = draft.vehicle.plate,
      let color = draft.vehicle.color
    else { return nil }

    var documents: [DriverApplicationDocumentDTO] = []
    documents.reserveCapacity(draft.documents.count)
    for slot in DocumentSlot.allCases {
      guard let doc = draft.documents[slot] else { return nil }
      documents.append(
        DriverApplicationDocumentDTO(
          kind: slot,
          storageKey: doc.localFileURL.lastPathComponent,
          mimeType: doc.mimeType,
          sizeBytes: doc.sizeBytes
        )
      )
    }

    return DriverApplicationRequestDTO(
      vehicleMake: make,
      vehicleModel: model,
      vehicleYear: year,
      vehiclePlate: plate,
      vehicleColor: color,
      licenseNumber: draft.licenseNumber,
      documents: documents
    )
  }
}

/// Wire response from `POST /v1/driver/applications`. Carries the
/// queue position + the driver-id created by the admin-side review
/// flow once approved. Until the endpoint lands, this DTO is unused
/// but the type lives here so the reducer's success path compiles.
public struct DriverApplicationResponseDTO: Decodable, Sendable, Equatable {
  public let applicationId: String
  public let status: String
  public let queuePosition: Int?

  public init(applicationId: String, status: String, queuePosition: Int?) {
    self.applicationId = applicationId
    self.status = status
    self.queuePosition = queuePosition
  }
}
