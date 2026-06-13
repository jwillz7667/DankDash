import Foundation
import DankDashDomain

/// Wire shape for the open-pool delivery surface
/// (`GET /v1/driver/deliveries/available`,
/// `POST /v1/driver/deliveries/:orderId/claim`).
///
/// The server nests pickup/drop-off as `{ lat, lng }` objects (decimal
/// degrees) rather than GeoJSON `[lng, lat]` tuples, so this DTO decodes
/// a flat ``GeoCoordinateDTO`` — there is no axis-flip ambiguity to guard
/// against the way ``GeoPointDTO`` has.
public struct GeoCoordinateDTO: Decodable, Sendable, Equatable {
  public let lat: Double
  public let lng: Double

  public init(lat: Double, lng: Double) {
    self.lat = lat
    self.lng = lng
  }

  public var asCoordinate: Coordinate {
    Coordinate(latitude: lat, longitude: lng)
  }
}

public struct AvailableDeliveryDTO: Decodable, Sendable, Equatable {
  public let orderId: String
  public let shortCode: String
  public let dispensaryId: String
  public let pickupName: String
  public let pickup: GeoCoordinateDTO
  public let dropoff: GeoCoordinateDTO
  public let tipCents: Int
  public let totalCents: Int
  public let distanceMeters: Double
  public let awaitingDriverAt: String?
}

public extension AvailableDeliveryDTO {
  /// Lossy projection — returns `nil` on any malformed scalar so a single
  /// bad row can't crash the whole board (the client drops it and keeps
  /// the rest).
  func toDomain() -> AvailableDelivery? {
    guard let parsedOrderId = CatalogWire.parseUUID(orderId) else { return nil }
    guard let parsedDispensaryId = CatalogWire.parseUUID(dispensaryId) else { return nil }
    // `awaitingDriverAt` is informational only; a missing/invalid value
    // is tolerated (nil) rather than dropping an otherwise-valid delivery.
    let parsedAwaitingAt: Date? = awaitingDriverAt.flatMap(CatalogWire.parseISO8601)

    return AvailableDelivery(
      orderId: parsedOrderId,
      shortCode: shortCode,
      dispensaryId: parsedDispensaryId,
      pickupName: pickupName,
      pickup: pickup.asCoordinate,
      dropoff: dropoff.asCoordinate,
      tipCents: tipCents,
      totalCents: totalCents,
      distanceMeters: distanceMeters,
      awaitingDriverAt: parsedAwaitingAt
    )
  }
}

public struct AvailableDeliveriesResponseDTO: Decodable, Sendable, Equatable {
  public let deliveries: [AvailableDeliveryDTO]

  public init(deliveries: [AvailableDeliveryDTO]) {
    self.deliveries = deliveries
  }
}

public struct ClaimDeliveryResponseDTO: Decodable, Sendable, Equatable {
  public let orderId: String
  public let status: String

  public init(orderId: String, status: String) {
    self.orderId = orderId
    self.status = status
  }
}
