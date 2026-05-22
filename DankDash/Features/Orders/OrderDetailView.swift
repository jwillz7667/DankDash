import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// Detail surface bound to ``OrderDetailFeature``. Composes the tracking
/// child for both **active** and **terminal** orders: active flights
/// show the live tracking layout, completed (or failed) orders swap the
/// driver / ETA strip for a static receipt + a "Reorder" CTA (enabled
/// only when ``OrderDetailFeature/State/canReorder`` is true, i.e. the
/// order ended in `.delivered`).
///
/// The rating sheet binds to `tracking.ratingDue` so the 5-minute
/// post-delivery prompt surfaces on the detail screen even if the user
/// navigates away and back. Dismissal dispatches through the tracking
/// child's `.dismissRatingSheet` to cancel the timer.
struct OrderDetailView: View {
  @Bindable var store: StoreOf<OrderDetailFeature>

  var body: some View {
    Group {
      if store.isTerminal {
        terminalLayout
      } else {
        OrderTrackingView(store: store.scope(state: \.tracking, action: \.tracking))
      }
    }
    .sheet(
      isPresented: Binding(
        get: { store.tracking.ratingDue },
        set: { isPresented in
          if !isPresented {
            store.send(.tracking(.dismissRatingSheet))
          }
        }
      )
    ) {
      RatingSheetView(store: store.scope(state: \.tracking, action: \.tracking))
        .presentationDetents([.medium, .large])
    }
  }

  // MARK: - Terminal layout

  /// Receipt-style layout for completed / failed orders. Re-uses the
  /// tracking timeline (which collapses to a failure card for non-
  /// `.delivered` terminal states) and adds the order-items list,
  /// totals, and the reorder CTA.
  private var terminalLayout: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: DankSpacing.lg) {
        if let order = store.tracking.order {
          header(order: order)

          OrderStatusTimeline(status: order.status)
            .padding(DankSpacing.md)
            .background(DankColor.cream)
            .clipShape(RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous))
            .overlay(
              RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous)
                .strokeBorder(DankColor.primary.opacity(0.08), lineWidth: 1)
            )

          itemsSection(order: order)
          totalsSection(order: order)
        } else if store.tracking.isLoading {
          loadingPlaceholder
        }

        if let error = store.tracking.error {
          errorBanner(error)
        }

        if store.canReorder {
          DankButton(
            "Reorder",
            style: .primary,
            size: .large,
            action: { store.send(.reorderTapped) }
          )
          .padding(.top, DankSpacing.md)
        }
      }
      .padding(.horizontal, DankSpacing.md)
      .padding(.vertical, DankSpacing.md)
    }
    .background(DankColor.cream.ignoresSafeArea())
    .navigationTitle(navigationTitle)
    .navigationBarTitleDisplayMode(.inline)
    .onAppear { store.send(.tracking(.onAppear)) }
    .onDisappear { store.send(.tracking(.onDisappear)) }
  }

  private var navigationTitle: String {
    store.tracking.order.map { "Order \($0.shortCode)" } ?? "Order"
  }

  // MARK: - Sections

  private func header(order: Order) -> some View {
    VStack(alignment: .leading, spacing: DankSpacing.xs) {
      HStack(spacing: DankSpacing.sm) {
        Text(order.shortCode)
          .font(DankFont.mono)
          .foregroundStyle(DankColor.Text.primary)
        OrderStatusPill(status: order.status)
        Spacer(minLength: 0)
      }
      Text(formatPrice(order.totalCents))
        .font(DankFont.title.monospacedDigit())
        .foregroundStyle(DankColor.Text.primary)
      Text("Placed \(formatPlacedAt(order.placedAt))")
        .font(DankFont.caption)
        .foregroundStyle(DankColor.Text.muted)
    }
    .accessibilityElement(children: .combine)
  }

  private func itemsSection(order: Order) -> some View {
    VStack(alignment: .leading, spacing: DankSpacing.sm) {
      Text("Items")
        .font(DankFont.caption)
        .tracking(0.8)
        .foregroundStyle(DankColor.Text.secondary)

      VStack(spacing: 0) {
        ForEach(Array(order.items.enumerated()), id: \.element.id) { index, item in
          itemRow(item: item)
            .padding(DankSpacing.sm)
          if index != order.items.count - 1 {
            Divider().background(DankColor.primary.opacity(0.08))
          }
        }
      }
      .background(DankColor.cream)
      .clipShape(RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous)
          .strokeBorder(DankColor.primary.opacity(0.08), lineWidth: 1)
      )
    }
  }

  /// Row for one ``OrderItem``. The product snapshot is captured at
  /// checkout time so the display name + brand survive catalog edits;
  /// snapshot fields missing → fall back to generic copy so the row
  /// still renders.
  private func itemRow(item: OrderItem) -> some View {
    let snapshot = item.productSnapshot.object
    let name = snapshot?["name"]?.string ?? "Item"
    let brand = snapshot?["brand"]?.string ?? ""
    return HStack(alignment: .top, spacing: DankSpacing.sm) {
      VStack(alignment: .leading, spacing: DankSpacing.xxs) {
        Text(name)
          .font(DankFont.body.weight(.semibold))
          .foregroundStyle(DankColor.Text.primary)
          .lineLimit(2)
        if !brand.isEmpty {
          Text(brand)
            .font(DankFont.caption)
            .foregroundStyle(DankColor.Text.secondary)
            .lineLimit(1)
        }
        Text("Qty \(item.quantity) · \(formatPrice(item.unitPriceCents)) each")
          .font(DankFont.caption)
          .foregroundStyle(DankColor.Text.muted)
      }
      Spacer(minLength: 0)
      Text(formatPrice(item.lineSubtotalCents))
        .font(DankFont.body.monospacedDigit().weight(.semibold))
        .foregroundStyle(DankColor.Text.primary)
    }
    .accessibilityElement(children: .combine)
  }

  /// Totals card mirroring the server's `orders_total_matches`
  /// invariant: subtotal + cannabis tax + sales tax + delivery + tip −
  /// discount = total. Each line is rendered only when non-zero so a
  /// receipt without a discount stays tight.
  private func totalsSection(order: Order) -> some View {
    VStack(spacing: DankSpacing.xs) {
      totalsRow(label: "Subtotal", cents: order.subtotalCents)
      if order.cannabisTaxCents > 0 {
        totalsRow(label: "Cannabis tax", cents: order.cannabisTaxCents)
      }
      if order.salesTaxCents > 0 {
        totalsRow(label: "Sales tax", cents: order.salesTaxCents)
      }
      if order.deliveryFeeCents > 0 {
        totalsRow(label: "Delivery", cents: order.deliveryFeeCents)
      }
      if order.driverTipCents > 0 {
        totalsRow(label: "Driver tip", cents: order.driverTipCents)
      }
      if order.discountCents > 0 {
        totalsRow(label: "Discount", cents: -order.discountCents)
      }
      Divider().background(DankColor.primary.opacity(0.12))
      totalsRow(label: "Total", cents: order.totalCents, emphasize: true)
    }
    .padding(DankSpacing.md)
    .background(DankColor.cream)
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous)
        .strokeBorder(DankColor.primary.opacity(0.08), lineWidth: 1)
    )
  }

  private func totalsRow(label: String, cents: Int, emphasize: Bool = false) -> some View {
    HStack {
      Text(label)
        .font(emphasize ? DankFont.headline : DankFont.body)
        .foregroundStyle(emphasize ? DankColor.Text.primary : DankColor.Text.secondary)
      Spacer(minLength: 0)
      Text(formatPrice(cents))
        .font((emphasize ? DankFont.headline : DankFont.body).monospacedDigit())
        .foregroundStyle(DankColor.Text.primary)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(label) \(formatPrice(cents))")
  }

  // MARK: - Helpers

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

  private var loadingPlaceholder: some View {
    VStack(spacing: DankSpacing.md) {
      ProgressView().controlSize(.large)
      Text("Loading order…")
        .font(DankFont.body)
        .foregroundStyle(DankColor.Text.secondary)
    }
    .frame(maxWidth: .infinity)
    .padding(.top, DankSpacing.xl)
  }

  private func formatPrice(_ cents: Int) -> String {
    let isNegative = cents < 0
    let magnitude = abs(cents)
    let dollars = Double(magnitude) / 100
    let f = NumberFormatter()
    f.numberStyle = .currency
    f.currencyCode = "USD"
    let str = f.string(from: NSNumber(value: dollars)) ?? "$\(dollars)"
    return isNegative ? "-\(str)" : str
  }

  private func formatPlacedAt(_ date: Date) -> String {
    let f = DateFormatter()
    f.dateStyle = .medium
    f.timeStyle = .short
    return f.string(from: date)
  }
}
