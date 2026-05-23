import Foundation
import DankDashDomain

/// Coordinate fix captured at the moment the driver tapped Confirm
/// Pickup or Mark Delivered. Mirror of the backend
/// `DriverLocationFixSchema`. `accuracyMeters` rides on the wire as a
/// nullable number so very-low-accuracy fixes still record (the request
/// shouldn't be rejected on a noisy GPS reading — ops can flag it from
/// the persisted value).
///
/// `capturedAt` is the DEVICE clock at the time of capture, not when
/// the request hit the server — the two can drift by seconds on a
/// flaky cell connection and the audit row needs the actual handoff
/// timing, not when the retry finally went through.
public struct DriverLocationFixDTO: Encodable, Sendable, Equatable {
  public let latitude: Double
  public let longitude: Double
  public let accuracyMeters: Double?
  public let capturedAt: String

  public init(latitude: Double, longitude: Double, accuracyMeters: Double?, capturedAt: String) {
    self.latitude = latitude
    self.longitude = longitude
    self.accuracyMeters = accuracyMeters
    self.capturedAt = capturedAt
  }

  /// Convenience init from the iOS domain types. `capturedAt` is encoded
  /// with fractional-second precision so it round-trips through the
  /// backend's `z.string().datetime({ offset: true })` validator.
  public init(coordinate: Coordinate, accuracyMeters: Double?, capturedAt: Date) {
    self.latitude = coordinate.latitude
    self.longitude = coordinate.longitude
    self.accuracyMeters = accuracyMeters
    self.capturedAt = Self.formatISO8601(capturedAt)
  }

  private enum CodingKeys: String, CodingKey {
    case latitude, longitude, accuracyMeters, capturedAt
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(latitude, forKey: .latitude)
    try container.encode(longitude, forKey: .longitude)
    if let accuracyMeters {
      try container.encode(accuracyMeters, forKey: .accuracyMeters)
    } else {
      try container.encodeNil(forKey: .accuracyMeters)
    }
    try container.encode(capturedAt, forKey: .capturedAt)
  }

  /// Allocates a fresh formatter per call — `ISO8601DateFormatter` is
  /// not `Sendable` under Swift 6 strict concurrency, and the existing
  /// `CatalogWire` helpers use the same idiom on the parse side.
  private static func formatISO8601(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }
}

/// Body for `POST /v1/driver/orders/:id/pickup-confirm`. The backend
/// schema is `.strict()` + `.nullable()` so the `location` key must be
/// present even when there is no fix to send — we encode an explicit
/// `null` rather than omitting it.
public struct DriverPickupConfirmRequestDTO: Encodable, Sendable, Equatable {
  public let location: DriverLocationFixDTO?

  public init(location: DriverLocationFixDTO?) {
    self.location = location
  }

  private enum CodingKeys: String, CodingKey { case location }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    if let location {
      try container.encode(location, forKey: .location)
    } else {
      try container.encodeNil(forKey: .location)
    }
  }
}

/// Body for `POST /v1/driver/orders/:id/delivery-confirm`. `notes` is
/// the driver's free-text marker ("Left with concierge", "Took photo
/// at door"); capped at 280 chars on the client to match the backend
/// constraint so the request never trips a 422.
public struct DriverDeliveryConfirmRequestDTO: Encodable, Sendable, Equatable {
  public let location: DriverLocationFixDTO?
  public let notes: String?

  public init(location: DriverLocationFixDTO?, notes: String?) {
    self.location = location
    let trimmed = notes?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let trimmed, !trimmed.isEmpty {
      self.notes = String(trimmed.prefix(280))
    } else {
      self.notes = nil
    }
  }

  private enum CodingKeys: String, CodingKey { case location, notes }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    if let location {
      try container.encode(location, forKey: .location)
    } else {
      try container.encodeNil(forKey: .location)
    }
    if let notes {
      try container.encode(notes, forKey: .notes)
    } else {
      try container.encodeNil(forKey: .notes)
    }
  }
}
