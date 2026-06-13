import SwiftUI
import DankDashDomain

/// Composed shift-home surface used by the DankDasher app. Stacks the
/// demand-heatmap map as a full-bleed background with the
/// ``ShiftToggle`` floated top-right and the ``EarningsSummaryCard``
/// pinned to the bottom edge.
///
/// All wiring is parent-owned: this view doesn't fire shift toggles or
/// fetch earnings — the parent reducer hands in the rendered state and
/// the two action closures.
public struct DriverMapHomeView: View {
  private let toggleMode: ShiftToggle.Mode
  private let cells: [DemandHeatmapCell]
  private let driverCoordinate: Coordinate?
  private let availableDeliveries: [AvailableDelivery]
  private let earnings: DriverEarnings?
  private let onToggleShift: () -> Void
  private let onEarningsTapped: () -> Void
  private let onDeliveryTapped: (AvailableDelivery) -> Void

  public init(
    toggleMode: ShiftToggle.Mode,
    cells: [DemandHeatmapCell],
    driverCoordinate: Coordinate?,
    availableDeliveries: [AvailableDelivery] = [],
    earnings: DriverEarnings?,
    onToggleShift: @escaping () -> Void,
    onEarningsTapped: @escaping () -> Void,
    onDeliveryTapped: @escaping (AvailableDelivery) -> Void = { _ in }
  ) {
    self.toggleMode = toggleMode
    self.cells = cells
    self.driverCoordinate = driverCoordinate
    self.availableDeliveries = availableDeliveries
    self.earnings = earnings
    self.onToggleShift = onToggleShift
    self.onEarningsTapped = onEarningsTapped
    self.onDeliveryTapped = onDeliveryTapped
  }

  public var body: some View {
    ZStack(alignment: .topTrailing) {
      DemandHeatmapMapView(
        cells: cells,
        driverCoordinate: driverCoordinate,
        availableDeliveries: availableDeliveries,
        onDeliveryTapped: onDeliveryTapped
      )
      .ignoresSafeArea(edges: .bottom)
      ShiftToggle(mode: toggleMode, onToggle: onToggleShift)
        .padding(.top, DankSpacing.md)
        .padding(.trailing, DankSpacing.md)
      VStack(spacing: 0) {
        Spacer(minLength: 0)
        EarningsSummaryCard(earnings: earnings, onTap: onEarningsTapped)
          .padding(.horizontal, DankSpacing.md)
          .padding(.bottom, DankSpacing.md)
      }
    }
  }
}

#Preview {
  DriverMapHomeView(
    toggleMode: .online,
    cells: [],
    driverCoordinate: Coordinate(latitude: 44.9778, longitude: -93.2650),
    earnings: DriverEarnings(
      period: .today,
      since: Date().addingTimeInterval(-86_400),
      until: Date(),
      tipsCents: 1850,
      deliveryFeesCents: 4500,
      deliveriesCount: 7,
      totalCents: 14_350
    ),
    onToggleShift: {},
    onEarningsTapped: {}
  )
}
