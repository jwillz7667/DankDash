import SwiftUI
import DankDashDesignSystem
import DankDashNetwork

/// Account tab. Today it carries the signed-in user identity plus the
/// sign-out CTA. Phase 19 adds order history; Phase 20+ adds payment
/// methods, addresses, and notification preferences. In DEBUG, a long-
/// press on the version label opens the Design Gallery.
struct AccountTabView: View {
  let user: UserSummaryDTO?
  let onSignOut: () -> Void

  #if DEBUG
  @State private var galleryShown = false
  #endif

  var body: some View {
    ScrollView {
      VStack(spacing: DankSpacing.lg) {
        identityCard
        sectionHeader("Coming soon")
        upcomingRow(icon: "clock.arrow.circlepath", title: "Order history", subtitle: "Track every order, including delivered + cancelled.")
        upcomingRow(icon: "creditcard", title: "Payment methods", subtitle: "Saved cards and ACH appear here in the next release.")
        upcomingRow(icon: "house", title: "Addresses", subtitle: "Manage delivery addresses across your trips.")
        upcomingRow(icon: "bell", title: "Notifications", subtitle: "Customize order, promotional, and compliance alerts.")
        Spacer(minLength: DankSpacing.lg)
        DankButton("Sign out", style: .ghost, size: .medium, action: onSignOut)
        versionFooter
      }
      .padding(DankSpacing.lg)
    }
    .background(DankColor.cream.ignoresSafeArea())
    .navigationTitle("Account")
    .navigationBarTitleDisplayMode(.inline)
    #if DEBUG
    .sheet(isPresented: $galleryShown) {
      DesignGalleryView()
    }
    #endif
  }

  private var identityCard: some View {
    DankCard {
      HStack(alignment: .center, spacing: DankSpacing.md) {
        ZStack {
          Circle()
            .fill(DankColor.primary.opacity(0.15))
            .frame(width: 56, height: 56)
          Text(initials)
            .font(DankFont.headline)
            .foregroundStyle(DankColor.primary)
            .accessibilityHidden(true)
        }
        VStack(alignment: .leading, spacing: DankSpacing.xxs) {
          Text(displayName)
            .font(DankFont.headline)
            .foregroundStyle(DankColor.Text.primary)
          if let email = user?.email {
            Text(email)
              .font(DankFont.bodySmall)
              .foregroundStyle(DankColor.Text.secondary)
          }
        }
        Spacer(minLength: 0)
      }
    }
  }

  private func sectionHeader(_ title: String) -> some View {
    HStack {
      Text(title.uppercased())
        .font(DankFont.caption)
        .tracking(1.2)
        .foregroundStyle(DankColor.Text.muted)
      Spacer()
    }
  }

  private func upcomingRow(icon: String, title: String, subtitle: String) -> some View {
    HStack(spacing: DankSpacing.sm) {
      Image(systemName: icon)
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(DankColor.primary)
        .frame(width: 32, height: 32)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: DankSpacing.xxs) {
        Text(title)
          .font(DankFont.body.weight(.semibold))
          .foregroundStyle(DankColor.Text.primary)
        Text(subtitle)
          .font(DankFont.bodySmall)
          .foregroundStyle(DankColor.Text.secondary)
      }
      Spacer(minLength: 0)
      Image(systemName: "lock.fill")
        .foregroundStyle(DankColor.Text.muted)
        .accessibilityLabel("Locked")
    }
    .padding(DankSpacing.sm)
    .background(DankColor.primary.opacity(0.04))
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(title). \(subtitle). Coming soon.")
  }

  private var versionFooter: some View {
    let text = Text(versionString)
      .font(DankFont.caption)
      .foregroundStyle(DankColor.Text.muted)

    #if DEBUG
    return text.onLongPressGesture(minimumDuration: 1.0) {
      galleryShown = true
    }
    #else
    return text
    #endif
  }

  private var displayName: String {
    let first = user?.firstName ?? ""
    let last = user?.lastName ?? ""
    let combined = "\(first) \(last)".trimmingCharacters(in: .whitespaces)
    return combined.isEmpty ? "Welcome" : combined
  }

  private var initials: String {
    let chars = displayName
      .split(separator: " ")
      .prefix(2)
      .compactMap { $0.first.map(String.init) }
    return chars.joined().uppercased().nonEmptyOr("D")
  }

  private var versionString: String {
    let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0"
    let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0"
    return "DankDash \(version) (\(build))"
  }
}

private extension String {
  func nonEmptyOr(_ fallback: String) -> String {
    isEmpty ? fallback : self
  }
}
