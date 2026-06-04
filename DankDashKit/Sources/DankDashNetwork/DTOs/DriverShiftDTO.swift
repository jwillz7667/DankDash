import Foundation
import DankDashDomain

/// Body for `POST /v1/driver/shift/start`. Wire shape:
/// `{ startingLocation: GeoJSON Point }`. The point's
/// `[longitude, latitude]` tuple ordering is RFC-7946 per `GeoPointDTO`
/// — the backend's `BoundedGeoPointSchema` clamps lat/lng so a
/// transposed pair fails at the server boundary instead of producing a
/// nonsense PostGIS row.
public struct StartShiftRequestDTO: Encodable, Sendable, Equatable {
  public let startingLocation: GeoPointDTO

  public init(startingLocation: GeoPointDTO) {
    self.startingLocation = startingLocation
  }

  /// Convenience init from a domain `Coordinate`. Used by the shift
  /// reducer when the first `BackgroundLocationClient` sample lands.
  public init(startingLocation: Coordinate) {
    self.startingLocation = GeoPointDTO(
      type: "Point",
      coordinates: [startingLocation.longitude, startingLocation.latitude]
    )
  }
}

/// Body for `POST /v1/driver/shift/end`. Mirror of the start body
/// — the closing-ping pair is what the dispatcher uses to anchor
/// drive-time analytics. The wire-side strict schema rejects unknown
/// keys, so adding fields here later requires a coordinated bump.
public struct EndShiftRequestDTO: Encodable, Sendable, Equatable {
  public let endingLocation: GeoPointDTO

  public init(endingLocation: GeoPointDTO) {
    self.endingLocation = endingLocation
  }

  public init(endingLocation: Coordinate) {
    self.endingLocation = GeoPointDTO(
      type: "Point",
      coordinates: [endingLocation.longitude, endingLocation.latitude]
    )
  }
}

/// Wire shape of the driver-shift row (`driver_shifts` projection).
/// `totalMiles` is the cumulative odometer reading flushed at shift
/// close; arrives as a Decimal-style string. Open shifts return
/// `endedAt = nil` and `endingLocation = nil`; the closing sums are
/// the partial-tally values the server keeps incrementing on each
/// delivery completion.
public struct DriverShiftResponseDTO: Decodable, Sendable, Equatable {
  public let id: String
  public let driverId: String
  public let startedAt: String
  public let endedAt: String?
  public let startingLocation: GeoPointDTO?
  public let endingLocation: GeoPointDTO?
  public let totalMiles: String?
  public let totalDeliveries: Int
  public let totalEarningsCents: Int

  public init(
    id: String,
    driverId: String,
    startedAt: String,
    endedAt: String?,
    startingLocation: GeoPointDTO?,
    endingLocation: GeoPointDTO?,
    totalMiles: String?,
    totalDeliveries: Int,
    totalEarningsCents: Int
  ) {
    self.id = id
    self.driverId = driverId
    self.startedAt = startedAt
    self.endedAt = endedAt
    self.startingLocation = startingLocation
    self.endingLocation = endingLocation
    self.totalMiles = totalMiles
    self.totalDeliveries = totalDeliveries
    self.totalEarningsCents = totalEarningsCents
  }
}

public extension DriverShiftResponseDTO {
  /// Lossy projection. Returns nil on a UUID / ISO-8601 parse failure
  /// or a malformed `totalMiles`. `startingLocation` / `endingLocation`
  /// failures (bad GeoJSON discriminator, wrong tuple arity) also fail
  /// the projection — a shift row with a corrupt location pin is a
  /// data-integrity bug we want to surface, not silently render with a
  /// missing pin.
  func toDomain() -> DriverShift? {
    guard let parsedID = CatalogWire.parseUUID(id) else { return nil }
    guard let parsedDriverID = CatalogWire.parseUUID(driverId) else { return nil }
    guard let parsedStartedAt = CatalogWire.parseISO8601(startedAt) else { return nil }

    let parsedEndedAt: Date?
    if let endedAt {
      guard let resolved = CatalogWire.parseISO8601(endedAt) else { return nil }
      parsedEndedAt = resolved
    } else {
      parsedEndedAt = nil
    }

    let parsedStartingLocation: Coordinate?
    if let startingLocation {
      guard let pair = startingLocation.asCoordinate else { return nil }
      parsedStartingLocation = Coordinate(latitude: pair.latitude, longitude: pair.longitude)
    } else {
      parsedStartingLocation = nil
    }

    let parsedEndingLocation: Coordinate?
    if let endingLocation {
      guard let pair = endingLocation.asCoordinate else { return nil }
      parsedEndingLocation = Coordinate(latitude: pair.latitude, longitude: pair.longitude)
    } else {
      parsedEndingLocation = nil
    }

    let parsedMiles: Decimal?
    if let totalMiles {
      guard let resolved = CatalogWire.parseDecimal(totalMiles) else { return nil }
      parsedMiles = resolved
    } else {
      parsedMiles = nil
    }

    return DriverShift(
      id: parsedID,
      driverId: parsedDriverID,
      startedAt: parsedStartedAt,
      endedAt: parsedEndedAt,
      startingLocation: parsedStartingLocation,
      endingLocation: parsedEndingLocation,
      totalMiles: parsedMiles,
      totalDeliveries: totalDeliveries,
      totalEarningsCents: totalEarningsCents
    )
  }
}
