import SwiftUI
import MapKit
import CoreLocation
import DankDashDomain

/// Live-tracking map for the order-tracking screen. Renders up to
/// three pins — dispensary, customer drop-off, driver — and a polyline
/// between them once a driver coordinate is available.
///
/// MapKit-backed per ADR-0006 (`docs/adr/0006-mapkit-over-mapbox-for-consumer-tracking.md`).
/// Uses SwiftUI's native `Map` (iOS 17 / macOS 14) with `Marker` + `MapPolyline`
/// so the file compiles on both platforms — Package.swift builds tests for
/// macOS too. The `MapClient` interface in Features is SDK-agnostic so a
/// future swap to Mapbox would only touch this file.
public struct LiveMapView: View {
  public struct Pin: Identifiable, Sendable {
    public enum Kind: Sendable {
      case dispensary
      case customer
      case driver
    }

    public let id: String
    public let kind: Kind
    public let coordinate: Coordinate
    public let title: String

    public init(id: String, kind: Kind, coordinate: Coordinate, title: String) {
      self.id = id
      self.kind = kind
      self.coordinate = coordinate
      self.title = title
    }
  }

  private let dispensary: Pin?
  private let customer: Pin
  private let driver: Pin?
  private let route: [Coordinate]?
  private let deliveryLeg: [Coordinate]?

  public init(
    dispensary: Pin?,
    customer: Pin,
    driver: Pin?,
    route: [Coordinate]? = nil,
    deliveryLeg: [Coordinate]? = nil
  ) {
    self.dispensary = dispensary
    self.customer = customer
    self.driver = driver
    self.route = route
    self.deliveryLeg = deliveryLeg
  }

  public var body: some View {
    Map(initialPosition: .region(initialRegion)) {
      if let dispensary {
        Marker(dispensary.title, systemImage: "storefront.fill", coordinate: dispensary.clCoordinate)
          .tint(DankColor.primary)
      }
      Marker(customer.title, systemImage: "house.fill", coordinate: customer.clCoordinate)
        .tint(DankColor.Semantic.success)
      if let driver {
        Marker(driver.title, systemImage: "car.fill", coordinate: driver.clCoordinate)
          .tint(DankColor.Semantic.warning)
      }
      // Delivery-preview leg (dispensary → drop-off) — drawn first and
      // dashed so the active leg reads on top where the two overlap.
      if let deliveryLeg, deliveryLeg.count >= 2 {
        MapPolyline(coordinates: deliveryLeg.map(\.clLocationCoordinate))
          .stroke(
            DankColor.primary.opacity(0.45),
            style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round, dash: [2, 9])
          )
      }
      // Active leg. Prefer the road-following polyline; fall back to a
      // straight driver → customer chord when no route is supplied (the
      // consumer tracking map before directions resolve).
      if let route, route.count >= 2 {
        MapPolyline(coordinates: route.map(\.clLocationCoordinate))
          .stroke(DankColor.primary, style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round))
      } else if let driver {
        MapPolyline(coordinates: [driver.clCoordinate, customer.clCoordinate])
          .stroke(DankColor.primary, lineWidth: 3)
      }
    }
    .mapStyle(.standard(elevation: .flat))
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityLabel)
  }

  private var initialRegion: MKCoordinateRegion {
    let pinCoordinates = [driver, dispensary, customer].compactMap { $0 }.map { $0.coordinate }
    let lineCoordinates = (route ?? []) + (deliveryLeg ?? [])
    let coordinates = pinCoordinates + lineCoordinates
    let coords = coordinates.map {
      CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude)
    }
    guard !coords.isEmpty else {
      return MKCoordinateRegion(
        center: customer.clCoordinate,
        latitudinalMeters: 2000,
        longitudinalMeters: 2000
      )
    }
    let lats = coords.map { $0.latitude }
    let lons = coords.map { $0.longitude }
    let minLat = lats.min() ?? customer.coordinate.latitude
    let maxLat = lats.max() ?? customer.coordinate.latitude
    let minLon = lons.min() ?? customer.coordinate.longitude
    let maxLon = lons.max() ?? customer.coordinate.longitude
    let center = CLLocationCoordinate2D(
      latitude: (minLat + maxLat) / 2,
      longitude: (minLon + maxLon) / 2
    )
    let span = MKCoordinateSpan(
      latitudeDelta: max(0.01, (maxLat - minLat) * 1.6),
      longitudeDelta: max(0.01, (maxLon - minLon) * 1.6)
    )
    return MKCoordinateRegion(center: center, span: span)
  }

  private var accessibilityLabel: String {
    if driver != nil {
      return "Live tracking map. Driver is on the way to \(customer.title)."
    }
    return "Map showing delivery to \(customer.title)."
  }
}

private extension LiveMapView.Pin {
  var clCoordinate: CLLocationCoordinate2D {
    CLLocationCoordinate2D(latitude: coordinate.latitude, longitude: coordinate.longitude)
  }
}

private extension Coordinate {
  var clLocationCoordinate: CLLocationCoordinate2D {
    CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
  }
}

#Preview {
  let dispensary = LiveMapView.Pin(
    id: "dispensary",
    kind: .dispensary,
    coordinate: Coordinate(latitude: 44.9778, longitude: -93.2650),
    title: "Greenleaf Co-op"
  )
  let customer = LiveMapView.Pin(
    id: "customer",
    kind: .customer,
    coordinate: Coordinate(latitude: 44.9836, longitude: -93.2766),
    title: "Home"
  )
  let driver = LiveMapView.Pin(
    id: "driver",
    kind: .driver,
    coordinate: Coordinate(latitude: 44.9805, longitude: -93.2708),
    title: "Sam"
  )
  // Driver → dispensary active leg, plus the dispensary → drop-off
  // preview leg the driver sees while heading to pickup.
  let activeLeg = [
    driver.coordinate,
    Coordinate(latitude: 44.9790, longitude: -93.2680),
    dispensary.coordinate,
  ]
  let previewLeg = [
    dispensary.coordinate,
    Coordinate(latitude: 44.9810, longitude: -93.2710),
    customer.coordinate,
  ]
  return VStack {
    LiveMapView(
      dispensary: dispensary,
      customer: customer,
      driver: driver,
      route: activeLeg,
      deliveryLeg: previewLeg
    )
    .frame(height: 220)
    LiveMapView(dispensary: dispensary, customer: customer, driver: nil)
      .frame(height: 220)
  }
  .padding()
  .background(DankColor.cream)
}
