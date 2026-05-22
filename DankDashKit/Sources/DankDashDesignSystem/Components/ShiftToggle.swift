import SwiftUI

/// Big pill the driver taps to flip between offline and online. Lives
/// in the top-right of the shift home map. The visual states are:
///
/// - `offline` — moss-on-cream "GO ONLINE", subtle outline
/// - `online` — danger-on-cream "GO OFFLINE", soft glow halo so it
///   reads at a glance while the map is busy
/// - `transitioning` — spinner inside the pill while the start/end
///   shift effect is in flight; disabled to block double-taps
/// - `lockedDuringDelivery` — disabled state during
///   `enRoutePickup` / `enRouteDropoff` so a driver can't accidentally
///   end a shift mid-delivery (server-side state machine would reject,
///   but the UI gates first)
///
/// All taps go through ``onToggle``; the parent reducer decides which
/// API call to fire based on the current driver status.
public struct ShiftToggle: View {
  public enum Mode: Sendable, Equatable {
    case offline
    case online
    case transitioning
    case lockedDuringDelivery
  }

  private let mode: Mode
  private let onToggle: () -> Void

  public init(mode: Mode, onToggle: @escaping () -> Void) {
    self.mode = mode
    self.onToggle = onToggle
  }

  public var body: some View {
    Button(action: onToggle) {
      ZStack {
        Text(title)
          .font(DankFont.headline)
          .foregroundStyle(foregroundColor)
          .opacity(mode == .transitioning ? 0 : 1)
        if mode == .transitioning {
          ProgressView()
            .progressViewStyle(.circular)
            .tint(foregroundColor)
        }
      }
      .frame(minWidth: 152, minHeight: 56)
      .padding(.horizontal, DankSpacing.lg)
      .background(background)
      .clipShape(Capsule())
      .overlay(
        Capsule().strokeBorder(borderColor, lineWidth: borderWidth)
      )
      .shadow(color: glowColor, radius: glowRadius, x: 0, y: 0)
      .opacity(isInteractive ? 1 : 0.65)
    }
    .disabled(!isInteractive)
    .accessibilityLabel(accessibilityLabel)
    .accessibilityAddTraits(.isButton)
  }

  public var title: String {
    Self.title(for: mode)
  }

  public static func title(for mode: Mode) -> String {
    switch mode {
    case .offline: "GO ONLINE"
    case .online: "GO OFFLINE"
    case .transitioning: "Working…"
    case .lockedDuringDelivery: "ON DELIVERY"
    }
  }

  public var isInteractive: Bool {
    Self.isInteractive(mode: mode)
  }

  public static func isInteractive(mode: Mode) -> Bool {
    switch mode {
    case .offline, .online: true
    case .transitioning, .lockedDuringDelivery: false
    }
  }

  private var foregroundColor: Color {
    switch mode {
    case .offline: DankColor.Text.onPrimary
    case .online: DankColor.Text.onPrimary
    case .transitioning: DankColor.Text.onPrimary
    case .lockedDuringDelivery: DankColor.Text.onPrimary
    }
  }

  @ViewBuilder private var background: some View {
    switch mode {
    case .offline: DankColor.primary
    case .online: DankColor.Semantic.danger
    case .transitioning: DankColor.primary
    case .lockedDuringDelivery: DankColor.Semantic.info
    }
  }

  private var borderColor: Color {
    switch mode {
    case .offline: DankColor.primaryDark
    case .online: DankColor.Semantic.danger.opacity(0.4)
    case .transitioning: DankColor.primaryDark
    case .lockedDuringDelivery: DankColor.Semantic.info
    }
  }

  private var borderWidth: CGFloat {
    switch mode {
    case .offline, .transitioning: 1.5
    case .online, .lockedDuringDelivery: 0
    }
  }

  private var glowColor: Color {
    switch mode {
    case .online: DankColor.Semantic.danger.opacity(0.45)
    default: .clear
    }
  }

  private var glowRadius: CGFloat {
    mode == .online ? 12 : 0
  }

  private var accessibilityLabel: String {
    switch mode {
    case .offline: "Go online to start receiving offers"
    case .online: "Currently online. Tap to go offline."
    case .transitioning: "Updating shift status"
    case .lockedDuringDelivery: "On an active delivery. Cannot go offline."
    }
  }
}

#Preview {
  VStack(spacing: DankSpacing.md) {
    ShiftToggle(mode: .offline, onToggle: {})
    ShiftToggle(mode: .online, onToggle: {})
    ShiftToggle(mode: .transitioning, onToggle: {})
    ShiftToggle(mode: .lockedDuringDelivery, onToggle: {})
  }
  .padding()
  .background(DankColor.cream)
}
