import Foundation
import ComposableArchitecture
import DankDashDomain
#if canImport(CoreLocation)
import CoreLocation
#endif

/// `@DependencyClient`-style wrapper around MapKit's `CLGeocoder.
/// geocodeAddressString(_:)`. The AddressPicker reducer composes a
/// street/city/region/postal code query, asks the client for a
/// `Coordinate`, and then attaches the result to a
/// ``CreateAddressRequestDTO`` before POSTing to `/v1/addresses`.
///
/// Geocoding runs entirely on-device through MapKit's free network call
/// to Apple — no API key, no rate-limit, no server hop. The server-side
/// addresses service trusts these coordinates rather than re-geocoding
/// (see `apps/api/src/modules/identity/addresses.service.ts` doc
/// comment: "expects callers to ship geocoded coordinates from the iOS
/// MapKit geocoder").
public struct GeocodingClient: Sendable {
  public var geocode: @Sendable (_ query: GeocodeQuery) async throws -> Coordinate

  public init(geocode: @Sendable @escaping (_ query: GeocodeQuery) async throws -> Coordinate) {
    self.geocode = geocode
  }

  /// Address-shape input that the live binding renders into a single
  /// string for CLGeocoder. Wrapped in a value type so tests can assert
  /// the exact query the reducer sent.
  public struct GeocodeQuery: Sendable, Equatable {
    public let line1: String
    public let line2: String?
    public let city: String
    public let region: String
    public let postalCode: String
    public let country: String

    public init(
      line1: String,
      line2: String? = nil,
      city: String,
      region: String,
      postalCode: String,
      country: String = "US"
    ) {
      self.line1 = line1
      self.line2 = line2
      self.city = city
      self.region = region
      self.postalCode = postalCode
      self.country = country
    }

    /// Single-line composition used by `CLGeocoder`. Empty parts are
    /// dropped so the query never contains ", , Minneapolis".
    public var formatted: String {
      var parts: [String] = [line1]
      if let line2, !line2.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        parts.append(line2)
      }
      parts.append("\(city), \(region) \(postalCode)")
      parts.append(country)
      return parts.joined(separator: ", ")
    }
  }
}

public extension GeocodingClient {
  /// Production binding. `CLGeocoder` is supported on iOS + macOS so
  /// there is no platform fork here — the `swift test` macOS target
  /// exercises the same code path the iOS device does.
  #if canImport(CoreLocation)
  static let live = GeocodingClient(
    geocode: { query in
      let geocoder = CLGeocoder()
      let placemarks = try await geocoder.geocodeAddressString(query.formatted)
      guard let coord = placemarks.first?.location?.coordinate else {
        throw GeocodingError.notFound
      }
      return Coordinate(latitude: coord.latitude, longitude: coord.longitude)
    }
  )
  #else
  static let live: GeocodingClient = .unimplemented
  #endif

  /// Test fixture that always reports "not found" so an unstubbed test
  /// gets an explicit `GeocodingError.notFound` rather than a confusing
  /// timeout.
  static let unimplemented = GeocodingClient(
    geocode: { _ in throw GeocodingError.unimplemented }
  )
}

public enum GeocodingError: Error, Equatable, Sendable, LocalizedError {
  case notFound
  case unimplemented

  public var errorDescription: String? {
    switch self {
    case .notFound:
      return "We couldn't find that address. Double-check the street and ZIP."
    case .unimplemented:
      return "Geocoder not configured."
    }
  }
}

private enum GeocodingClientKey: DependencyKey {
  static let liveValue: GeocodingClient = .live
  static let testValue: GeocodingClient = .unimplemented
}

public extension DependencyValues {
  var geocodingClient: GeocodingClient {
    get { self[GeocodingClientKey.self] }
    set { self[GeocodingClientKey.self] = newValue }
  }
}
