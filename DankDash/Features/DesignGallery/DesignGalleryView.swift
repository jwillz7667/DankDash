import SwiftUI
import DankDashDesignSystem

/// Debug-only inventory of every brand component variant. Per Phase 16
/// DoD: "Design system documented in a sample gallery view." Renders the
/// full token surface (color/typography/spacing/radius) plus every
/// public component initializer in both light and dark color schemes so
/// regressions are visually obvious. The view is read-only — no state,
/// no actions, no navigation side effects.
struct DesignGalleryView: View {
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: DankSpacing.lg) {
        header
        colorSection
        typographySection
        spacingSection
        radiusSection
        buttonSection
        inputSection
        badgeSection
        cardSection
        logoSection
        loaderSection
      }
      .padding(DankSpacing.lg)
      .frame(maxWidth: 720)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(DankColor.cream)
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: DankSpacing.xs) {
      Text("DankDash Design System")
        .font(DankFont.display)
        .foregroundStyle(DankColor.Text.primary)
      Text("Phase 16 reference gallery — every public token + component variant.")
        .font(DankFont.body)
        .foregroundStyle(DankColor.Text.secondary)
    }
  }

  private var colorSection: some View {
    section(title: "Color tokens") {
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), spacing: DankSpacing.sm)], spacing: DankSpacing.sm) {
        ForEach(DankColor.allTokens, id: \.name) { token in
          ColorSwatch(token: token)
        }
      }
    }
  }

  private var typographySection: some View {
    section(title: "Typography") {
      VStack(alignment: .leading, spacing: DankSpacing.sm) {
        ForEach(DankFont.allTokens, id: \.name) { token in
          HStack(alignment: .firstTextBaseline, spacing: DankSpacing.md) {
            Text(token.name)
              .font(DankFont.caption)
              .foregroundStyle(DankColor.Text.muted)
              .frame(width: 88, alignment: .leading)
            Text("The quick brown fox 0123")
              .font(font(for: token.name))
              .foregroundStyle(DankColor.Text.primary)
          }
        }
      }
    }
  }

  private var spacingSection: some View {
    section(title: "Spacing") {
      VStack(alignment: .leading, spacing: DankSpacing.xs) {
        ForEach(DankSpacing.allTokens, id: \.name) { token in
          HStack(spacing: DankSpacing.sm) {
            Text(token.name)
              .font(DankFont.caption)
              .foregroundStyle(DankColor.Text.muted)
              .frame(width: 48, alignment: .leading)
            Rectangle()
              .fill(DankColor.primary)
              .frame(width: token.value, height: 12)
            Text("\(Int(token.value))pt")
              .font(DankFont.caption)
              .foregroundStyle(DankColor.Text.secondary)
          }
        }
      }
    }
  }

  private var radiusSection: some View {
    section(title: "Radii") {
      HStack(spacing: DankSpacing.md) {
        ForEach(DankRadius.allTokens, id: \.name) { token in
          VStack(spacing: DankSpacing.xs) {
            RoundedRectangle(cornerRadius: min(token.value, 36), style: .continuous)
              .fill(DankColor.primary)
              .frame(width: 64, height: 64)
            Text(token.name)
              .font(DankFont.caption)
              .foregroundStyle(DankColor.Text.muted)
          }
        }
      }
    }
  }

  private var buttonSection: some View {
    section(title: "Buttons") {
      VStack(spacing: DankSpacing.sm) {
        DankButton("Primary", style: .primary, action: {})
        DankButton("Secondary", style: .secondary, action: {})
        DankButton("Ghost", style: .ghost, action: {})
        DankButton("Destructive", style: .destructive, action: {})
        DankButton("Loading", isLoading: true, action: {})
        DankButton("Disabled", isDisabled: true, action: {})
        HStack(spacing: DankSpacing.sm) {
          DankButton("Small", size: .small, action: {})
          DankButton("Medium", size: .medium, action: {})
          DankButton("Large", size: .large, action: {})
        }
      }
    }
  }

  private var inputSection: some View {
    section(title: "Inputs") {
      InputSamples()
    }
  }

  private var badgeSection: some View {
    section(title: "Badges") {
      FlowingBadges()
    }
  }

  private var cardSection: some View {
    section(title: "Cards") {
      VStack(spacing: DankSpacing.md) {
        DankCard {
          Text("Solid surface")
            .font(DankFont.headline)
            .foregroundStyle(DankColor.Text.primary)
        }
        DankCard(style: .frosted) {
          Text("Frosted dispensary card")
            .font(DankFont.headline)
            .foregroundStyle(DankColor.Text.onPrimary)
        }
      }
    }
  }

  private var logoSection: some View {
    section(title: "Logos") {
      HStack(spacing: DankSpacing.lg) {
        ForEach(DankLogo.Variant.allCases, id: \.self) { variant in
          VStack(spacing: DankSpacing.xs) {
            DankLogo(variant, size: 88)
            Text(label(for: variant))
              .font(DankFont.caption)
              .foregroundStyle(DankColor.Text.muted)
          }
        }
      }
    }
  }

  private var loaderSection: some View {
    section(title: "Loaders") {
      HStack(spacing: DankSpacing.lg) {
        DankLoader(size: .small)
        DankLoader(size: .medium)
        DankLoader(size: .large)
      }
    }
  }

  @ViewBuilder
  private func section<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: DankSpacing.sm) {
      Text(title)
        .font(DankFont.headline)
        .foregroundStyle(DankColor.Text.primary)
      content()
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(DankSpacing.md)
    .background(
      RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous)
        .strokeBorder(DankColor.primary.opacity(0.12), lineWidth: 1)
    )
  }

  private func font(for name: String) -> Font {
    switch name {
    case "display": DankFont.display
    case "title": DankFont.title
    case "headline": DankFont.headline
    case "body": DankFont.body
    case "bodySmall": DankFont.bodySmall
    case "caption": DankFont.caption
    case "mono": DankFont.mono
    default: DankFont.body
    }
  }

  private func label(for variant: DankLogo.Variant) -> String {
    switch variant {
    case .mark: "mark"
    case .wordmark: "wordmark"
    case .full: "full"
    }
  }
}

private struct ColorSwatch: View {
  let token: DankColorToken

  var body: some View {
    VStack(alignment: .leading, spacing: DankSpacing.xxs) {
      RoundedRectangle(cornerRadius: DankRadius.sm, style: .continuous)
        .fill(Color(hex: token.hex))
        .frame(height: 56)
        .overlay(
          RoundedRectangle(cornerRadius: DankRadius.sm, style: .continuous)
            .strokeBorder(DankColor.primary.opacity(0.12), lineWidth: 1)
        )
      Text(token.name)
        .font(DankFont.caption)
        .foregroundStyle(DankColor.Text.primary)
      Text(String(format: "#%06X", token.hex))
        .font(DankFont.mono.weight(.regular))
        .foregroundStyle(DankColor.Text.muted)
    }
  }
}

private extension Color {
  init(hex: UInt32) {
    let r = Double((hex >> 16) & 0xFF) / 255
    let g = Double((hex >> 8) & 0xFF) / 255
    let b = Double(hex & 0xFF) / 255
    self.init(.sRGB, red: r, green: g, blue: b, opacity: 1)
  }
}

private struct InputSamples: View {
  @State private var email = "ada@dankdash.test"
  @State private var password = ""
  @State private var phone = "+14155551234"
  @State private var bad = "not-an-email"

  var body: some View {
    VStack(spacing: DankSpacing.sm) {
      DankInput(label: "Email", placeholder: "you@dankdash.test", text: $email, kind: .email, validation: .valid)
      DankInput(label: "Password", text: $password, kind: .secure, helper: "12+ chars, letter + digit")
      DankInput(label: "Phone", placeholder: "+14155551234", text: $phone, kind: .phone)
      DankInput(label: "Invalid", text: $bad, kind: .email, validation: .invalid("Enter a valid email"))
    }
  }
}

private struct FlowingBadges: View {
  var body: some View {
    HStack(spacing: DankSpacing.xs) {
      ForEach(DankBadge.Tone.allCases, id: \.self) { tone in
        DankBadge(label(for: tone), tone: tone)
      }
    }
  }

  private func label(for tone: DankBadge.Tone) -> String {
    switch tone {
    case .neutral: "Neutral"
    case .success: "Verified"
    case .warning: "Warning"
    case .danger: "Blocked"
    case .info: "Info"
    case .accent: "Premium"
    }
  }
}

#Preview("Light") {
  DesignGalleryView()
    .preferredColorScheme(.light)
}

#Preview("Dark") {
  DesignGalleryView()
    .preferredColorScheme(.dark)
}
