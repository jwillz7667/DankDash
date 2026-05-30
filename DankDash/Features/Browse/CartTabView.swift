import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// In-memory cart draft surface. Apple §10.4: the consumer iOS app is
/// menu-only — the "Continue to checkout" CTA is intentionally disabled
/// here. Phase 18 wires the Safari handoff to `app.dankdash.com/checkout`.
struct CartTabView: View {
  @Bindable var store: StoreOf<LocalCartDraftFeature>

  var body: some View {
    Group {
      if store.isEmpty {
        EmptyStateView(
          systemImage: "bag",
          title: "Your cart is empty",
          message: "Add products from any dispensary's menu. Items stay here until you check out on dankdash.com."
        )
      } else {
        VStack(spacing: 0) {
          ScrollView {
            VStack(spacing: DankSpacing.sm) {
              ForEach(store.lines) { line in
                CartLineRow(
                  line: line,
                  onIncrement: {
                    store.send(.setQuantity(listingId: line.listingId, quantity: line.quantity + 1))
                  },
                  onDecrement: {
                    store.send(.setQuantity(listingId: line.listingId, quantity: line.quantity - 1))
                  },
                  onRemove: {
                    store.send(.removeLine(listingId: line.listingId))
                  }
                )
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
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        if !store.isEmpty {
          Button("Clear") {
            store.send(.clearAll)
          }
          .foregroundStyle(DankColor.Semantic.danger)
        }
      }
    }
  }

  private var checkoutBar: some View {
    VStack(spacing: DankSpacing.sm) {
      HStack {
        Text("Subtotal")
          .font(DankFont.body)
          .foregroundStyle(DankColor.Text.secondary)
        Spacer()
        Text(formatPrice(store.totalCents))
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
  let onIncrement: () -> Void
  let onDecrement: () -> Void
  let onRemove: () -> Void

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
        HStack(spacing: DankSpacing.xs) {
          Button(action: onDecrement) {
            Image(systemName: line.quantity <= 1 ? "trash" : "minus")
              .frame(width: 28, height: 28)
              .foregroundStyle(line.quantity <= 1 ? DankColor.Semantic.danger : DankColor.primary)
          }
          .accessibilityLabel(line.quantity <= 1 ? "Remove item" : "Decrease quantity")
          Text("\(line.quantity)")
            .font(DankFont.body.weight(.semibold))
            .frame(minWidth: 20)
            .accessibilityLabel("Quantity \(line.quantity)")
          Button(action: onIncrement) {
            Image(systemName: "plus")
              .frame(width: 28, height: 28)
              .foregroundStyle(line.quantity >= line.maxAvailable ? DankColor.Text.muted : DankColor.primary)
          }
          .disabled(line.quantity >= line.maxAvailable)
          .accessibilityLabel("Increase quantity")
        }
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
    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
      Button(role: .destructive, action: onRemove) {
        Label("Remove", systemImage: "trash")
      }
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
