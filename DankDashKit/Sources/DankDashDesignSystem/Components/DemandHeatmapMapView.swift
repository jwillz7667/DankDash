import SwiftUI
import MapKit
import CoreLocation
import DankDashDomain

/// Driver-shift map renderer that paints demand-heatmap cells as filled
/// polygons over a MapKit base. Each ``DemandHeatmapCell`` becomes a
/// `MapPolygon` whose fill color comes from a moss → amber → danger
/// gradient keyed off the cell's `demandScore` (0...1).
///
/// MapKit + SwiftUI's native `Map` per ADR-0006 — same precedent as
/// ``LiveMapView``. Cross-platform because the package builds tests on
/// macOS too; a `UIViewRepresentable` over `MKMapView` would limit us
/// to iOS only and would force the package's macOS test build to skip
/// this file.
public struct DemandHeatmapMapView: View {
  private let cells: [DemandHeatmapCell]
  private let driverCoordinate: Coordinate?
  private let availableDeliveries: [AvailableDelivery]
  private let initialCenter: Coordinate
  private let onDeliveryTapped: (AvailableDelivery) -> Void

  public init(
    cells: [DemandHeatmapCell],
    driverCoordinate: Coordinate?,
    availableDeliveries: [AvailableDelivery] = [],
    initialCenter: Coordinate = Coordinate(latitude: 44.9778, longitude: -93.2650),
    onDeliveryTapped: @escaping (AvailableDelivery) -> Void = { _ in }
  ) {
    self.cells = cells
    self.driverCoordinate = driverCoordinate
    self.availableDeliveries = availableDeliveries
    self.initialCenter = initialCenter
    self.onDeliveryTapped = onDeliveryTapped
  }

  public var body: some View {
    Map(initialPosition: .region(initialRegion)) {
      ForEach(cells) { cell in
        MapPolygon(coordinates: cell.polygon.map(Self.clCoordinate(from:)))
          .foregroundStyle(
            Self.fillColor(for: cell.demandScore).opacity(0.55)
          )
          .stroke(
            Self.fillColor(for: cell.demandScore).opacity(0.9),
            lineWidth: 1
          )
      }
      // Open-pool pickup pins — each carries the tip floating above the
      // glyph; tapping one opens the claim sheet (parent-owned).
      ForEach(availableDeliveries) { delivery in
        Annotation(
          delivery.pickupName,
          coordinate: Self.clCoordinate(from: delivery.pickup)
        ) {
          Button {
            onDeliveryTapped(delivery)
          } label: {
            DeliveryPinLabel(tipDollars: delivery.tipDollars)
          }
          .buttonStyle(.plain)
          .accessibilityLabel(
            "Delivery from \(delivery.pickupName), tip \(Self.tipText(delivery.tipDollars))"
          )
          .accessibilityIdentifier("shift.deliveryPin.\(delivery.orderId.uuidString)")
        }
        .annotationTitles(.hidden)
      }
      if let driverCoordinate {
        Marker(
          "You",
          systemImage: "location.fill",
          coordinate: Self.clCoordinate(from: driverCoordinate)
        )
        .tint(DankColor.primary)
      }
    }
    .mapStyle(.standard(elevation: .flat))
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous))
    .accessibilityElement(children: .contain)
    .accessibilityLabel(accessibilityLabel)
  }

  static func tipText(_ tipDollars: Decimal) -> String {
    tipDollars.formatted(.currency(code: "USD").precision(.fractionLength(0...2)))
  }

  // MARK: - Math

  private var initialRegion: MKCoordinateRegion {
    let anchor = driverCoordinate ?? initialCenter
    return MKCoordinateRegion(
      center: Self.clCoordinate(from: anchor),
      latitudinalMeters: 8000,
      longitudinalMeters: 8000
    )
  }

  private var accessibilityLabel: String {
    let deliveryPart = availableDeliveries.isEmpty
      ? ""
      : " \(availableDeliveries.count) available deliveries."
    if cells.isEmpty {
      return "Map with no demand cells available.\(deliveryPart)"
    }
    return "Demand heatmap with \(cells.count) cells.\(deliveryPart)"
  }

  /// Linear interpolation across the moss (low) → amber (medium) → danger
  /// (high) gradient. Score is clamped to 0...1; the moss-to-amber
  /// transition happens at 0.5.
  public static func fillColor(for score: Decimal) -> Color {
    let clamped = max(min(score, Decimal(1)), Decimal(0))
    let nsScore = NSDecimalNumber(decimal: clamped).doubleValue
    let moss = ColorComponents(r: 0.10, g: 0.26, b: 0.08)
    let amber = ColorComponents(r: 0.79, g: 0.66, b: 0.38)
    let danger = ColorComponents(r: 0.70, g: 0.15, b: 0.12)
    let mixed: ColorComponents
    if nsScore <= 0.5 {
      let t = nsScore / 0.5
      mixed = moss.lerp(amber, t: t)
    } else {
      let t = (nsScore - 0.5) / 0.5
      mixed = amber.lerp(danger, t: t)
    }
    return Color(.sRGB, red: mixed.r, green: mixed.g, blue: mixed.b, opacity: 1)
  }

  fileprivate static func clCoordinate(from coordinate: Coordinate) -> CLLocationCoordinate2D {
    CLLocationCoordinate2D(latitude: coordinate.latitude, longitude: coordinate.longitude)
  }
}

private struct ColorComponents {
  let r: Double
  let g: Double
  let b: Double

  func lerp(_ other: ColorComponents, t: Double) -> ColorComponents {
    ColorComponents(
      r: r + (other.r - r) * t,
      g: g + (other.g - g) * t,
      b: b + (other.b - b) * t
    )
  }
}

/// Map annotation glyph for a claimable delivery: the tip dollar amount
/// in a capsule floating above a storefront pin. Sized to stay legible
/// against the heatmap fills without dominating the map.
private struct DeliveryPinLabel: View {
  let tipDollars: Decimal

  var body: some View {
    VStack(spacing: 1) {
      Text(DemandHeatmapMapView.tipText(tipDollars))
        .font(DankFont.caption.weight(.bold))
        .foregroundStyle(DankColor.cream)
        .padding(.horizontal, DankSpacing.xs)
        .padding(.vertical, 2)
        .background(DankColor.primary, in: Capsule())
        .overlay(Capsule().strokeBorder(DankColor.cream.opacity(0.9), lineWidth: 1))
      Image(systemName: "bag.fill")
        .font(.system(size: 14, weight: .bold))
        .foregroundStyle(DankColor.cream)
        .padding(7)
        .background(DankColor.primary, in: Circle())
        .overlay(Circle().strokeBorder(DankColor.cream.opacity(0.9), lineWidth: 1.5))
      Image(systemName: "triangle.fill")
        .font(.system(size: 8))
        .foregroundStyle(DankColor.primary)
        .rotationEffect(.degrees(180))
        .offset(y: -3)
    }
    .shadow(color: DankColor.Text.primary.opacity(0.25), radius: 3, x: 0, y: 1)
  }
}

#Preview {
  DemandHeatmapMapView(
    cells: [
      DemandHeatmapCell(
        cellId: "cell-1",
        polygon: [
          Coordinate(latitude: 44.978, longitude: -93.270),
          Coordinate(latitude: 44.980, longitude: -93.265),
          Coordinate(latitude: 44.978, longitude: -93.260),
          Coordinate(latitude: 44.976, longitude: -93.265),
        ],
        demandScore: Decimal(string: "0.85")!
      ),
      DemandHeatmapCell(
        cellId: "cell-2",
        polygon: [
          Coordinate(latitude: 44.974, longitude: -93.270),
          Coordinate(latitude: 44.976, longitude: -93.265),
          Coordinate(latitude: 44.974, longitude: -93.260),
          Coordinate(latitude: 44.972, longitude: -93.265),
        ],
        demandScore: Decimal(string: "0.25")!
      ),
    ],
    driverCoordinate: Coordinate(latitude: 44.9778, longitude: -93.2650)
  )
  .frame(height: 320)
  .padding()
  .background(DankColor.cream)
}
