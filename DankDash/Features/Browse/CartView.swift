import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// Full server-cart screen. Replaces the Phase-17 ``CartTabView`` shell
/// with the production UX: server-cart line items + quantity stepper,
/// three-bar compliance preview, address picker entry, "Continue to
/// checkout — opens in Safari" CTA (Apple §10.4), expiry countdown, and
/// error / loading banners.
///
/// The view dispatches `.onAppear` / `.onDisappear` so the reducer can
/// kick off promotion + load addresses on entry and cancel running
/// effects on tab change. The address picker sheet binds to the cart's
/// own `addressPicker` child; the Safari hand-off sheet is owned one
/// layer up by ``BrowseFeature`` and presented by ``BrowseRootView``.
struct CartView: View {
  @Bindable var store: StoreOf<CartFeature>
  let cdnBaseURL: URL?

  var body: some View {
    Group {
      if isEmpty {
        EmptyStateView(
          systemImage: "bag",
          title: "Your cart is empty",
          message: "Add products from any dispensary's menu. Checkout opens on dankdash.com."
        )
      } else if store.isPromoting && store.serverCart == nil {
        promotingPlaceholder
      } else {
        contentScroll
      }
    }
    .background(DankColor.cream.ignoresSafeArea())
    .navigationTitle("Cart")
    .navigationBarTitleDisplayMode(.inline)
    .onAppear { store.send(.onAppear) }
    .onDisappear { store.send(.onDisappear) }
    .sheet(
      isPresented: Binding(
        get: { store.addressPicker != nil },
        set: { isPresented in
          if !isPresented { store.send(.addressPicker(.dismissTapped)) }
        }
      )
    ) {
      if let pickerStore = store.scope(state: \.addressPicker, action: \.addressPicker) {
        NavigationStack {
          AddressPickerView(store: pickerStore)
        }
      }
    }
  }

  // MARK: - Empty state

  /// Empty if there are no draft seeds AND no server-cart items. We
  /// don't treat a mid-promotion state with cleared draft + non-nil
  /// server cart as empty; that's the "loaded" branch below.
  private var isEmpty: Bool {
    store.draft.isEmpty && (store.serverCart?.isEmpty ?? true)
  }

  private var promotingPlaceholder: some View {
    VStack(spacing: DankSpacing.md) {
      ProgressView().controlSize(.large)
      Text("Preparing your cart…")
        .font(DankFont.body)
        .foregroundStyle(DankColor.Text.secondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  // MARK: - Loaded content

  private var contentScroll: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(spacing: DankSpacing.md) {
          if let secondsRemaining = store.expirySecondsRemaining {
            CartExpiryBanner(remaining: TimeInterval(secondsRemaining))
              .padding(.horizontal, DankSpacing.md)
          }

          if let error = store.error {
            errorBanner(error)
              .padding(.horizontal, DankSpacing.md)
          }

          itemList
            .padding(.horizontal, DankSpacing.md)

          if let evaluation = store.evaluation {
            ComplianceSummaryBanner(evaluation: evaluation)
              .padding(.horizontal, DankSpacing.md)
          }

          addressSection
            .padding(.horizontal, DankSpacing.md)
        }
        .padding(.top, DankSpacing.md)
        .padding(.bottom, DankSpacing.xl)
      }
      checkoutBar
    }
  }

  // MARK: - Items

  /// Pre-promotion we render local draft lines; post-promotion the
  /// server cart is authoritative. The crossover happens inside the
  /// reducer (`promotionFinished` clears the draft + sets server cart)
  /// so the two never overlap visually.
  @ViewBuilder private var itemList: some View {
    if let serverCart = store.serverCart {
      VStack(spacing: 0) {
        ForEach(serverCart.items) { item in
          serverLine(item)
          if item.id != serverCart.items.last?.id {
            Divider().background(DankColor.primary.opacity(0.08))
          }
        }
      }
      .background(DankColor.cream)
      .clipShape(RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous)
          .strokeBorder(DankColor.primary.opacity(0.1), lineWidth: 1)
      )
    } else {
      VStack(spacing: 0) {
        ForEach(store.draft.lines) { line in
          draftLine(line)
          if line.id != store.draft.lines.last?.id {
            Divider().background(DankColor.primary.opacity(0.08))
          }
        }
      }
      .background(DankColor.cream)
      .clipShape(RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous)
          .strokeBorder(DankColor.primary.opacity(0.1), lineWidth: 1)
      )
    }
  }

  private func serverLine(_ item: CartItem) -> some View {
    let info = store.productInfo[item.listingId]
    return LineItemRow(
      listingId: item.listingId,
      productName: info?.name ?? "Item",
      brand: info?.brand ?? "",
      imageKey: info?.imageKey,
      cdnBaseURL: cdnBaseURL,
      unitPriceCents: item.unitPriceCents,
      lineSubtotalCents: item.lineSubtotalCents,
      quantity: item.quantity,
      maxQuantity: 99,
      isPending: store.isValidating,
      onIncrement: { store.send(.quantityStepped(itemId: item.id, quantity: item.quantity + 1)) },
      onDecrement: { store.send(.quantityStepped(itemId: item.id, quantity: item.quantity - 1)) }
    )
    .padding(.horizontal, DankSpacing.sm)
  }

  /// Draft lines pre-promotion are read-only: the stepper is wired but
  /// disabled until the cart is created on the server (the line ids are
  /// local UUIDs that don't exist server-side yet).
  private func draftLine(_ line: LocalCartDraft.Line) -> some View {
    LineItemRow(
      listingId: line.listingId,
      productName: line.productName,
      brand: line.brand,
      imageKey: nil,
      cdnBaseURL: cdnBaseURL,
      unitPriceCents: line.priceCents,
      lineSubtotalCents: line.subtotalCents,
      quantity: line.quantity,
      maxQuantity: line.quantity,
      isPending: store.isPromoting,
      onIncrement: {},
      onDecrement: {}
    )
    .padding(.horizontal, DankSpacing.sm)
    .opacity(store.isPromoting ? 0.7 : 1)
  }

  // MARK: - Address

  @ViewBuilder private var addressSection: some View {
    VStack(alignment: .leading, spacing: DankSpacing.xs) {
      Text("Delivery to")
        .font(DankFont.caption)
        .tracking(0.8)
        .foregroundStyle(DankColor.Text.secondary)

      if store.isLoadingAddresses {
        HStack(spacing: DankSpacing.sm) {
          ProgressView().controlSize(.small)
          Text("Loading addresses…")
            .font(DankFont.bodySmall)
            .foregroundStyle(DankColor.Text.muted)
          Spacer(minLength: 0)
        }
        .padding(.vertical, DankSpacing.sm)
      } else if let address = store.selectedAddress {
        AddressRow(
          address: address,
          accessory: .chevron,
          action: { store.send(.openAddressPickerTapped) }
        )
      } else {
        DankButton(
          "Choose delivery address",
          style: .secondary,
          size: .medium,
          action: { store.send(.openAddressPickerTapped) }
        )
      }
    }
    .padding(DankSpacing.md)
    .background(DankColor.cream)
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous)
        .strokeBorder(DankColor.primary.opacity(0.1), lineWidth: 1)
    )
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

  // MARK: - Checkout bar

  private var checkoutBar: some View {
    VStack(spacing: DankSpacing.sm) {
      HStack {
        Text("Subtotal")
          .font(DankFont.body)
          .foregroundStyle(DankColor.Text.secondary)
        Spacer()
        Text(formatPrice(subtotalCents))
          .font(DankFont.headline.monospacedDigit())
          .foregroundStyle(DankColor.Text.primary)
      }
      CheckoutCTAButton(
        isLoading: store.isPromoting || store.isValidating,
        isEnabled: store.canCheckout,
        action: { store.send(.checkoutTapped) }
      )
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

  /// Server cart is authoritative once it lands; before then the draft
  /// subtotal previews the post-promotion total. The two paths are
  /// mutually exclusive (server-cart presence clears the draft).
  private var subtotalCents: Int {
    store.serverCart?.subtotalCents ?? store.draft.totalCents
  }

  private func formatPrice(_ cents: Int) -> String {
    let dollars = Double(cents) / 100
    let f = NumberFormatter()
    f.numberStyle = .currency
    f.currencyCode = "USD"
    return f.string(from: NSNumber(value: dollars)) ?? "$\(dollars)"
  }
}
