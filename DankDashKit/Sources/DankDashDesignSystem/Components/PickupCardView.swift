import SwiftUI
import DankDashDomain

/// Pickup leg surface — what the driver sees when the route is in
/// ``RouteLeg/toPickup``. Renders the dispensary name + one-line
/// address, an ETA + distance chip, and the "Confirm Pickup" CTA that
/// transitions the order to `picked_up` server-side.
///
/// The card sits below the map; the CTA is full-width at the bottom so
/// the driver can tap it while parking without looking. Disabling
/// (`isConfirming = true`) blocks double-taps while the POST is in
/// flight.
public struct PickupCardView: View {
  private let dispensary: DriverHandoffDispensary
  private let etaMinutes: Int?
  private let distanceMiles: Decimal?
  private let isConfirming: Bool
  private let onConfirm: () -> Void

  public init(
    dispensary: DriverHandoffDispensary,
    etaMinutes: Int?,
    distanceMiles: Decimal?,
    isConfirming: Bool,
    onConfirm: @escaping () -> Void
  ) {
    self.dispensary = dispensary
    self.etaMinutes = etaMinutes
    self.distanceMiles = distanceMiles
    self.isConfirming = isConfirming
    self.onConfirm = onConfirm
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: DankSpacing.md) {
      header
      addressBlock
      if etaMinutes != nil || distanceMiles != nil {
        metricsRow
      }
      confirmButton
    }
    .padding(DankSpacing.lg)
    .background(DankColor.background)
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous)
        .strokeBorder(DankColor.primary.opacity(0.12), lineWidth: 1)
    )
  }

  private var header: some View {
    HStack(alignment: .top, spacing: DankSpacing.sm) {
      Image(systemName: "shippingbox.fill")
        .font(DankFont.headline)
        .foregroundStyle(DankColor.primary)
        .frame(width: 28, height: 28)
      VStack(alignment: .leading, spacing: 2) {
        Text("Pickup")
          .font(DankFont.caption)
          .foregroundStyle(DankColor.Text.muted)
          .textCase(.uppercase)
        Text(dispensary.name)
          .font(DankFont.headline)
          .foregroundStyle(DankColor.Text.onBackground)
      }
    }
  }

  private var addressBlock: some View {
    Text(dispensary.oneLine)
      .font(DankFont.body)
      .foregroundStyle(DankColor.Text.secondary)
      .multilineTextAlignment(.leading)
      .accessibilityLabel("Address: \(dispensary.oneLine)")
  }

  private var metricsRow: some View {
    HStack(spacing: DankSpacing.lg) {
      if let etaMinutes {
        metric(label: "ETA", value: "\(etaMinutes) min")
      }
      if let distanceMiles {
        metric(label: "Distance", value: PickupCardView.formatDistance(distanceMiles))
      }
      Spacer()
    }
  }

  private func metric(label: String, value: String) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label)
        .font(DankFont.caption)
        .foregroundStyle(DankColor.Text.muted)
        .textCase(.uppercase)
      Text(value)
        .font(DankFont.headline)
        .foregroundStyle(DankColor.Text.onBackground)
    }
  }

  private var confirmButton: some View {
    Button(action: onConfirm) {
      ZStack {
        Text("Confirm Pickup")
          .font(DankFont.headline)
          .foregroundStyle(DankColor.Text.onPrimary)
          .opacity(isConfirming ? 0 : 1)
        if isConfirming {
          ProgressView()
            .progressViewStyle(.circular)
            .tint(DankColor.Text.onPrimary)
        }
      }
      .frame(maxWidth: .infinity, minHeight: 52)
      .background(DankColor.primary)
      .clipShape(Capsule())
    }
    .disabled(isConfirming)
    .accessibilityLabel("Confirm pickup from \(dispensary.name)")
  }

  public static func formatDistance(_ miles: Decimal) -> String {
    let formatter = NumberFormatter()
    formatter.numberStyle = .decimal
    formatter.minimumFractionDigits = 1
    formatter.maximumFractionDigits = 1
    let value = formatter.string(from: miles as NSDecimalNumber) ?? "0.0"
    return "\(value) mi"
  }
}

#Preview {
  PickupCardView(
    dispensary: DriverHandoffDispensary(
      id: UUID(),
      name: "Bloom Cannabis Co.",
      addressLine1: "401 N 3rd St",
      addressLine2: nil,
      city: "Minneapolis",
      region: "MN",
      postalCode: "55401",
      location: Coordinate(latitude: 44.985, longitude: -93.270),
      phone: nil
    ),
    etaMinutes: 6,
    distanceMiles: Decimal(string: "2.4")!,
    isConfirming: false,
    onConfirm: {}
  )
  .padding()
  .background(DankColor.Text.muted.opacity(0.1))
}
