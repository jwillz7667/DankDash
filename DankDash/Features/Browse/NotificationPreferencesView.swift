import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// Notification-preferences screen bound to ``NotificationPreferencesFeature``.
/// Pushed from the Account tab. Two grouped cards — *Categories* (which kinds
/// of notifications) and *Channels* (how they arrive) — each a list of
/// switches. Flipping a switch is optimistic and self-contained: the toggle
/// flips immediately, shows an inline spinner while its single-key PATCH is
/// in flight, and reverts with an error banner if the write fails.
///
/// The in-app inbox is intentionally not represented — those records are
/// always written and have no toggle. The footer explains that, and that
/// transactional/operational notifications (account, driver) are always
/// delivered regardless of these switches.
struct NotificationPreferencesView: View {
  @Bindable var store: StoreOf<NotificationPreferencesFeature>

  private struct Row: Identifiable {
    let toggle: NotificationToggle
    let title: String
    let subtitle: String
    let icon: String
    var id: NotificationToggle { toggle }
  }

  private let categoryRows: [Row] = [
    Row(
      toggle: .orderUpdates,
      title: "Order updates",
      subtitle: "Status changes, driver ETA, and delivery confirmations.",
      icon: "shippingbox"
    ),
    Row(
      toggle: .promotions,
      title: "Promotions & deals",
      subtitle: "Drops, discounts, and dispensary specials near you.",
      icon: "tag"
    ),
  ]

  private let channelRows: [Row] = [
    Row(
      toggle: .push,
      title: "Push notifications",
      subtitle: "Alerts on this device.",
      icon: "bell.badge"
    ),
    Row(
      toggle: .sms,
      title: "Text messages",
      subtitle: "SMS to your verified phone number.",
      icon: "message"
    ),
    Row(
      toggle: .email,
      title: "Email",
      subtitle: "Receipts and updates to your inbox.",
      icon: "envelope"
    ),
  ]

  var body: some View {
    ScrollView {
      VStack(spacing: DankSpacing.md) {
        if let error = store.error {
          errorBanner(error)
        }

        if store.isLoading && store.preferences == nil {
          loadingRow
        } else {
          section(title: "Categories", rows: categoryRows)
          section(title: "Channels", rows: channelRows)
        }

        disclaimer
      }
      .padding(DankSpacing.lg)
    }
    .background(DankColor.cream.ignoresSafeArea())
    .navigationTitle("Notifications")
    .navigationBarTitleDisplayMode(.inline)
    .task { store.send(.onAppear) }
    .refreshable { store.send(.refreshTapped) }
  }

  // MARK: - Sections

  private func section(title: String, rows: [Row]) -> some View {
    DankCard {
      VStack(alignment: .leading, spacing: DankSpacing.sm) {
        Text(title.uppercased())
          .font(DankFont.caption.weight(.semibold))
          .foregroundStyle(DankColor.Text.muted)
          .accessibilityAddTraits(.isHeader)

        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
          if index > 0 {
            Divider().overlay(DankColor.primary.opacity(0.12))
          }
          toggleRow(row)
        }
      }
    }
  }

  private func toggleRow(_ row: Row) -> some View {
    let isSaving = store.savingToggles.contains(row.toggle)
    return HStack(alignment: .center, spacing: DankSpacing.sm) {
      Image(systemName: row.icon)
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(DankColor.primary)
        .frame(width: 32, height: 32)
        .accessibilityHidden(true)

      VStack(alignment: .leading, spacing: DankSpacing.xxs) {
        Text(row.title)
          .font(DankFont.body.weight(.semibold))
          .foregroundStyle(DankColor.Text.primary)
        Text(row.subtitle)
          .font(DankFont.bodySmall)
          .foregroundStyle(DankColor.Text.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      Spacer(minLength: DankSpacing.sm)

      if isSaving {
        ProgressView().controlSize(.small)
      }

      Toggle(
        "",
        isOn: Binding(
          get: { store.preferences?.value(for: row.toggle) ?? true },
          set: { store.send(.toggleChanged(row.toggle, $0)) }
        )
      )
      .labelsHidden()
      .tint(DankColor.primary)
      .disabled(isSaving || store.preferences == nil)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(row.title)
    .accessibilityValue((store.preferences?.value(for: row.toggle) ?? true) ? "On" : "Off")
  }

  // MARK: - States

  private var loadingRow: some View {
    HStack(spacing: DankSpacing.sm) {
      ProgressView().controlSize(.small)
      Text("Loading preferences…")
        .font(DankFont.bodySmall)
        .foregroundStyle(DankColor.Text.muted)
      Spacer(minLength: 0)
    }
    .padding(.vertical, DankSpacing.lg)
  }

  private var disclaimer: some View {
    Text(
      "In-app messages always appear in your inbox. Account and delivery safety "
        + "alerts are always sent and can't be turned off."
    )
    .font(DankFont.caption)
    .foregroundStyle(DankColor.Text.muted)
    .multilineTextAlignment(.center)
    .padding(.top, DankSpacing.xs)
  }

  private func errorBanner(_ message: String) -> some View {
    HStack(alignment: .top, spacing: DankSpacing.xs) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(DankColor.Semantic.danger)
        .accessibilityHidden(true)
      Text(message)
        .font(DankFont.bodySmall)
        .foregroundStyle(DankColor.Text.primary)
      Spacer(minLength: 0)
    }
    .padding(DankSpacing.md)
    .background(DankColor.Semantic.danger.opacity(0.08))
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Error: \(message)")
  }
}
