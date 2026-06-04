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
  private let initialCenter: Coordinate

  public init(
    cells: [DemandHeatmapCell],
    driverCoordinate: Coordinate?,
    initialCenter: Coordinate = Coordinate(latitude: 44.9778, longitude: -93.2650)
  ) {
    self.cells = cells
    self.driverCoordinate = driverCoordinate
    self.initialCenter = initialCenter
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
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityLabel)
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
    if cells.isEmpty {
      return "Map with no demand cells available."
    }
    return "Demand heatmap with \(cells.count) cells."
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
