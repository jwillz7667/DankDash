import SwiftUI
import DankDashDomain

/// Dropoff leg surface — what the driver sees once the route is in
/// ``RouteLeg/toDropoff``. Renders the customer's display name +
/// masked phone, the drop address one-liner, the delivery
/// instructions (if any), and the "I've Arrived" CTA that pushes the
/// driver into the ID-scan handoff screen.
///
/// Customer surname is collapsed to a single initial ("Sam J.") by the
/// `DriverHandoffCustomer.displayName` projection so the driver never
/// sees the full surname on-screen.
public struct DropoffCardView: View {
  private let customer: DriverHandoffCustomer
  private let address: DriverHandoffAddress
  private let etaMinutes: Int?
  private let distanceMiles: Decimal?
  private let isArriving: Bool
  private let onArrived: () -> Void

  public init(
    customer: DriverHandoffCustomer,
    address: DriverHandoffAddress,
    etaMinutes: Int?,
    distanceMiles: Decimal?,
    isArriving: Bool,
    onArrived: @escaping () -> Void
  ) {
    self.customer = customer
    self.address = address
    self.etaMinutes = etaMinutes
    self.distanceMiles = distanceMiles
    self.isArriving = isArriving
    self.onArrived = onArrived
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: DankSpacing.md) {
      header
      addressBlock
      if let instructions = address.instructions?.trimmingCharacters(in: .whitespacesAndNewlines),
         !instructions.isEmpty {
        instructionsBlock(instructions)
      }
      if etaMinutes != nil || distanceMiles != nil {
        metricsRow
      }
      arrivedButton
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
      Image(systemName: "house.fill")
        .font(DankFont.headline)
        .foregroundStyle(DankColor.primary)
        .frame(width: 28, height: 28)
      VStack(alignment: .leading, spacing: 2) {
        Text("Dropoff")
          .font(DankFont.caption)
          .foregroundStyle(DankColor.Text.muted)
          .textCase(.uppercase)
        Text(customer.displayName)
          .font(DankFont.headline)
          .foregroundStyle(DankColor.Text.onBackground)
        if let phone = customer.maskedPhone {
          Text(phone)
            .font(DankFont.caption)
            .foregroundStyle(DankColor.Text.muted)
            .accessibilityLabel("Masked phone \(phone)")
        }
      }
    }
  }

  private var addressBlock: some View {
    Text(address.oneLine)
      .font(DankFont.body)
      .foregroundStyle(DankColor.Text.secondary)
      .multilineTextAlignment(.leading)
      .accessibilityLabel("Address: \(address.oneLine)")
  }

  private func instructionsBlock(_ instructions: String) -> some View {
    HStack(alignment: .top, spacing: DankSpacing.xs) {
      Image(systemName: "text.bubble.fill")
        .font(DankFont.caption)
        .foregroundStyle(DankColor.Text.muted)
      Text(instructions)
        .font(DankFont.bodySmall)
        .foregroundStyle(DankColor.Text.secondary)
        .lineLimit(4)
    }
    .padding(DankSpacing.sm)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(DankColor.Text.muted.opacity(0.08))
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
  }

  private var metricsRow: some View {
    HStack(spacing: DankSpacing.lg) {
      if let etaMinutes {
        metric(label: "ETA", value: "\(etaMinutes) min")
      }
      if let distanceMiles {
        metric(label: "Distance", value: DropoffCardView.formatDistance(distanceMiles))
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

  private var arrivedButton: some View {
    Button(action: onArrived) {
      ZStack {
        Text("I've Arrived")
          .font(DankFont.headline)
          .foregroundStyle(DankColor.Text.onPrimary)
          .opacity(isArriving ? 0 : 1)
        if isArriving {
          ProgressView()
            .progressViewStyle(.circular)
            .tint(DankColor.Text.onPrimary)
        }
      }
      .frame(maxWidth: .infinity, minHeight: 52)
      .background(DankColor.primary)
      .clipShape(Capsule())
    }
    .disabled(isArriving)
    .accessibilityLabel("Confirm arrival at dropoff for \(customer.displayName)")
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
  DropoffCardView(
    customer: DriverHandoffCustomer(
      firstName: "Sam",
      lastName: "Johnson",
      maskedPhone: "***-***-1234"
    ),
    address: DriverHandoffAddress(
      line1: "1234 Hennepin Ave",
      line2: "Apt 4B",
      city: "Minneapolis",
      region: "MN",
      postalCode: "55403",
      location: Coordinate(latitude: 44.974, longitude: -93.275),
      instructions: "Ring buzzer #4B. Building has secure entry — please wait by the gate."
    ),
    etaMinutes: 4,
    distanceMiles: Decimal(string: "1.6")!,
    isArriving: false,
    onArrived: {}
  )
  .padding()
  .background(DankColor.Text.muted.opacity(0.1))
}
