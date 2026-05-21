import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// Cart-tab shell. Renders the draft accumulator as a read-only list
/// against the Phase-18 ``CartFeature`` state. The full server-cart UX
/// (quantity stepper against the server row, compliance preview, Safari
/// hand-off CTA) lands in C20 — this shell exists only to keep the
/// app target compiling against the new state shape introduced when
/// ``BrowseFeature`` swaps its `cart` member from ``LocalCartDraftFeature``
/// to ``CartFeature``.
///
/// Apple §10.4: the "Continue to checkout" CTA stays disabled here —
/// the real hand-off button is wired in C20.
struct CartTabView: View {
  let store: StoreOf<CartFeature>

  var body: some View {
    Group {
      if store.draft.isEmpty {
        EmptyStateView(
          systemImage: "bag",
          title: "Your cart is empty",
          message: "Add products from any dispensary's menu. Items stay here until you check out on dankdash.com."
        )
      } else {
        VStack(spacing: 0) {
          ScrollView {
            VStack(spacing: DankSpacing.sm) {
              ForEach(store.draft.lines) { line in
                CartLineRow(line: line)
              }
            }
            .padding(.horizontal, DankSpacing.md)
            .padding(.vertical, DankSpacing.sm)
          }
          checkoutBar
        }
      }
    }
    .background(DankColor.cream.ignoresSafeArea())
    .navigationTitle("Cart")
    .navigationBarTitleDisplayMode(.inline)
  }

  private var checkoutBar: some View {
    VStack(spacing: DankSpacing.sm) {
      HStack {
        Text("Subtotal")
          .font(DankFont.body)
          .foregroundStyle(DankColor.Text.secondary)
        Spacer()
        Text(formatPrice(store.draft.totalCents))
          .font(DankFont.headline)
          .foregroundStyle(DankColor.Text.primary)
      }
      DankButton(
        "Continue to checkout — coming soon",
        style: .primary,
        size: .large,
        isDisabled: true,
        action: {}
      )
      .accessibilityHint("Checkout opens on dankdash.com — available in the next release.")
      Text("Checkout opens on dankdash.com per App Store policy.")
        .font(DankFont.caption)
        .foregroundStyle(DankColor.Text.muted)
        .multilineTextAlignment(.center)
    }
    .padding(DankSpacing.md)
    .background(DankColor.cream)
    .overlay(alignment: .top) {
      Rectangle()
        .fill(DankColor.primary.opacity(0.08))
        .frame(height: 1)
    }
  }

  private func formatPrice(_ cents: Int) -> String {
    let dollars = Double(cents) / 100
    let f = NumberFormatter()
    f.numberStyle = .currency
    f.currencyCode = "USD"
    return f.string(from: NSNumber(value: dollars)) ?? "$\(dollars)"
  }
}

private struct CartLineRow: View {
  let line: LocalCartDraft.Line

  var body: some View {
    HStack(alignment: .top, spacing: DankSpacing.sm) {
      RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous)
        .fill(DankColor.primary.opacity(0.08))
        .frame(width: 64, height: 64)
        .overlay(
          Image(systemName: "leaf")
            .foregroundStyle(DankColor.primary.opacity(0.5))
        )
        .accessibilityHidden(true)

      VStack(alignment: .leading, spacing: DankSpacing.xxs) {
        Text(line.brand.uppercased())
          .font(DankFont.caption)
          .tracking(0.8)
          .foregroundStyle(DankColor.Text.secondary)
        Text(line.productName)
          .font(DankFont.body.weight(.semibold))
          .foregroundStyle(DankColor.Text.primary)
          .lineLimit(2)
        Text(formatPrice(line.priceCents))
          .font(DankFont.bodySmall)
          .foregroundStyle(DankColor.Text.muted)
      }

      Spacer(minLength: 0)

      VStack(alignment: .trailing, spacing: DankSpacing.xs) {
        Text(formatPrice(line.subtotalCents))
          .font(DankFont.body.weight(.semibold))
          .foregroundStyle(DankColor.Text.primary)
        Text("Qty \(line.quantity)")
          .font(DankFont.bodySmall)
          .foregroundStyle(DankColor.Text.muted)
          .accessibilityLabel("Quantity \(line.quantity)")
      }
    }
    .padding(DankSpacing.sm)
    .background(DankColor.cream)
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous)
        .strokeBorder(DankColor.primary.opacity(0.1), lineWidth: 1)
    )
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(line.brand) \(line.productName), quantity \(line.quantity), \(formatPrice(line.subtotalCents))")
  }

  private func formatPrice(_ cents: Int) -> String {
    let dollars = Double(cents) / 100
    let f = NumberFormatter()
    f.numberStyle = .currency
    f.currencyCode = "USD"
    return f.string(from: NSNumber(value: dollars)) ?? "$\(dollars)"
  }
}
