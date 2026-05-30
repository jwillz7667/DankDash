import SwiftUI
import DankDashDomain

/// Driver identity card shown on the order-tracking screen once a driver
/// has been assigned. Renders avatar (or initials), display name, vehicle
/// summary, and a tap-to-call masked phone number.
///
/// The masked phone is server-supplied — iOS never derives it. The tap
/// handler routes through Twilio Proxy in Phase 23; Phase 18 just dials
/// the masked-display number directly via `tel:` URL composition handled
/// in the parent.
public struct DriverCard: View {
  private let driver: DriverPublicProfile
  private let cdnBaseURL: URL?
  private let onCall: (() -> Void)?

  public init(
    driver: DriverPublicProfile,
    cdnBaseURL: URL?,
    onCall: (() -> Void)? = nil
  ) {
    self.driver = driver
    self.cdnBaseURL = cdnBaseURL
    self.onCall = onCall
  }

  public var body: some View {
    HStack(spacing: DankSpacing.md) {
      avatar
      VStack(alignment: .leading, spacing: DankSpacing.xxs) {
        Text(driver.displayName)
          .font(DankFont.headline)
          .foregroundStyle(DankColor.Text.primary)
          .lineLimit(1)
        if let vehicle = driver.vehicleSummary, !vehicle.isEmpty {
          Text(vehicle)
            .font(DankFont.caption)
            .foregroundStyle(DankColor.Text.secondary)
            .lineLimit(1)
        }
        if let phone = driver.maskedPhone, !phone.isEmpty {
          Text(phone)
            .font(DankFont.caption.monospacedDigit())
            .foregroundStyle(DankColor.Text.muted)
        }
      }
      Spacer(minLength: 0)
      if let onCall, let phone = driver.maskedPhone, !phone.isEmpty {
        Button(action: onCall) {
          Image(systemName: "phone.fill")
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(DankColor.Text.onPrimary)
            .frame(width: 44, height: 44)
            .background(DankColor.primary)
            .clipShape(Circle())
        }
        .accessibilityLabel("Call driver")
        .accessibilityHint(phone)
      }
    }
    .padding(DankSpacing.md)
    .background(
      RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous)
        .fill(DankColor.cream)
    )
    .overlay(
      RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous)
        .strokeBorder(DankColor.primary.opacity(0.08), lineWidth: 1)
    )
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder
  private var avatar: some View {
    if let avatarKey = driver.avatarKey, !avatarKey.isEmpty {
      DankAsyncImage(
        imageKey: avatarKey,
        cdnBaseURL: cdnBaseURL,
        contentMode: .fill,
        aspectRatio: 1
      )
      .frame(width: 56, height: 56)
      .clipShape(Circle())
    } else {
      ZStack {
        Circle()
          .fill(DankColor.primary.opacity(0.12))
        Text(driver.initials)
          .font(DankFont.headline)
          .foregroundStyle(DankColor.primary)
      }
      .frame(width: 56, height: 56)
      .accessibilityHidden(true)
    }
  }
}

#Preview {
  VStack(spacing: DankSpacing.md) {
    DriverCard(
      driver: DriverPublicProfile(
        id: UUID(),
        displayName: "Sam Driver",
        avatarKey: nil,
        vehicleSummary: "Blue 2021 Honda Civic",
        maskedPhone: "+1 ••• ••• 1234"
      ),
      cdnBaseURL: nil,
      onCall: {}
    )
    DriverCard(
      driver: DriverPublicProfile(
        id: UUID(),
        displayName: "Anonymous",
        avatarKey: nil,
        vehicleSummary: nil,
        maskedPhone: nil
      ),
      cdnBaseURL: nil
    )
  }
  .padding()
  .background(DankColor.cream)
}
