import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// Driver shift home — the post-onboarding root surface. Hands the
/// reducer's state to ``DriverMapHomeView`` (heatmap + toggle + earnings
/// card) and presents the two sheets the reducer can request:
///
/// 1. ``AuthorizationRationaleView`` when ``isShowingLocationRationale``
///    flips to true (driver tapped GO ONLINE without Always location)
/// 2. The driver-status menu when ``isShowingStatusMenu`` flips to true
///    (driver tapped the current-status pill to switch to On Break /
///    Unavailable, recoverable to Online)
///
/// The dismissible error banner is overlaid at the top of the safe
/// area so it doesn't steal the map's tap targets, and a small
/// driver-status pill sits above the earnings card so the driver always
/// knows what dispatch sees.
struct ShiftHomeView: View {
  @Bindable var store: StoreOf<DriverShiftFeature>
  let onSignOut: () -> Void

  var body: some View {
    ZStack(alignment: .top) {
      DriverMapHomeView(
        toggleMode: toggleMode,
        cells: store.heatmap,
        driverCoordinate: store.currentCoordinate,
        earnings: store.earningsToday,
        onToggleShift: { store.send(.toggleOnlineTapped) },
        onEarningsTapped: { store.send(.earningsCardTapped) }
      )

      VStack(spacing: DankSpacing.sm) {
        if let banner = store.errorBanner {
          errorBanner(banner)
            .padding(.horizontal, DankSpacing.md)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
        Spacer(minLength: 0)
      }
      .padding(.top, DankSpacing.sm)
      .animation(.easeInOut(duration: 0.2), value: store.errorBanner)

      VStack(spacing: 0) {
        Spacer(minLength: 0)
        if store.driver?.currentOrderId != nil {
          returnToDeliveryBanner
            .padding(.horizontal, DankSpacing.md)
            .padding(.bottom, DankSpacing.sm)
        }
        statusBar
          .padding(.horizontal, DankSpacing.md)
          .padding(.bottom, 96)
      }
    }
    .task { store.send(.onAppear) }
    .sheet(
      isPresented: Binding(
        get: { store.isShowingLocationRationale },
        set: { isShown in
          if !isShown { store.send(.locationRationaleDismissed) }
        }
      )
    ) {
      AuthorizationRationaleView(
        onAllow: { store.send(.locationRationaleAllowTapped) },
        onDismiss: { store.send(.locationRationaleDismissed) }
      )
    }
    .sheet(
      isPresented: Binding(
        get: { store.isShowingStatusMenu },
        set: { isShown in
          if !isShown { store.send(.statusMenuDismissed) }
        }
      )
    ) {
      statusMenuSheet
        .presentationDetents([.medium])
    }
    .sheet(
      isPresented: Binding(
        get: { store.presentedOffer != nil },
        set: { isShown in
          if !isShown { store.send(.offerSheetDismissed) }
        }
      )
    ) {
      offerSheetContent
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(store.presentedOffer?.isSubmitting == true)
    }
  }

  @ViewBuilder
  private var offerSheetContent: some View {
    if let offerStore = store.scope(state: \.presentedOffer, action: \.presentedOffer) {
      OfferCardView(
        offer: offerStore.offer,
        pickupSummary: "Pickup details",
        dropoffSummary: "Loading destination",
        secondsRemaining: offerStore.secondsRemaining,
        isSubmitting: offerStore.isSubmitting,
        onAccept: { offerStore.send(.acceptTapped) },
        onDecline: { offerStore.send(.declineTapped) }
      )
      .task { offerStore.send(.onAppear) }
    }
  }

  // MARK: - Toggle mode derivation

  /// Maps reducer flags onto the design-system pill modes. Order
  /// matters — the transition state hides the toggle while a shift
  /// start/end is in flight, and the locked-during-delivery branch
  /// takes priority over the simple online/offline split because the
  /// underlying status (`enRoutePickup` / `enRouteDropoff`) still
  /// counts as on-shift.
  private var toggleMode: ShiftToggle.Mode {
    if store.isPerformingShiftTransition { return .transitioning }
    if store.driver?.isOnActiveDelivery == true { return .lockedDuringDelivery }
    return store.isOnline ? .online : .offline
  }

  // MARK: - Error banner

  private func errorBanner(_ message: String) -> some View {
    HStack(alignment: .top, spacing: DankSpacing.sm) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(DankColor.Semantic.danger)
        .accessibilityHidden(true)
      Text(message)
        .font(DankFont.bodySmall)
        .foregroundStyle(DankColor.Text.primary)
      Spacer(minLength: 0)
      Button {
        store.send(.errorBannerDismissed)
      } label: {
        Image(systemName: "xmark")
          .font(DankFont.caption)
          .foregroundStyle(DankColor.Text.muted)
      }
      .accessibilityLabel("Dismiss")
      .accessibilityIdentifier("shift.errorBanner.dismiss")
    }
    .padding(DankSpacing.sm)
    .background(DankColor.cream)
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous)
        .strokeBorder(DankColor.Semantic.danger.opacity(0.4), lineWidth: 1)
    )
    .shadow(color: DankColor.Text.primary.opacity(0.08), radius: 8, x: 0, y: 2)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Error: \(message)")
    .accessibilityIdentifier("shift.errorBanner")
  }

  // MARK: - Return-to-delivery banner

  /// Shown whenever the driver still carries an order but is looking at
  /// the shift home (backed out of the route screen, or the screen
  /// refreshed mid-delivery). The shift toggle is locked in this state,
  /// so without this button there is no path back to the active route.
  private var returnToDeliveryBanner: some View {
    Button {
      store.send(.returnToDeliveryTapped)
    } label: {
      HStack(spacing: DankSpacing.sm) {
        Image(systemName: "shippingbox.fill")
          .font(DankFont.bodySmall)
          .foregroundStyle(DankColor.cream)
          .accessibilityHidden(true)
        Text("Delivery in progress")
          .font(DankFont.bodySmall.weight(.semibold))
          .foregroundStyle(DankColor.cream)
        Spacer(minLength: 0)
        Text("Return to delivery")
          .font(DankFont.caption)
          .foregroundStyle(DankColor.cream.opacity(0.85))
        Image(systemName: "chevron.right")
          .font(DankFont.caption)
          .foregroundStyle(DankColor.cream.opacity(0.85))
      }
      .padding(.horizontal, DankSpacing.md)
      .padding(.vertical, DankSpacing.sm)
      .background(DankColor.primary)
      .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
      .shadow(color: DankColor.Text.primary.opacity(0.12), radius: 8, x: 0, y: 2)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Delivery in progress. Return to delivery.")
    .accessibilityIdentifier("shift.returnToDelivery")
  }

  // MARK: - Status bar above the earnings card

  private var statusBar: some View {
    Button {
      store.send(.statusMenuTapped)
    } label: {
      HStack(spacing: DankSpacing.sm) {
        DriverStatusPill(status: store.driver?.currentStatus ?? .offline)
        Spacer(minLength: 0)
        if store.isOnline {
          Text("Change")
            .font(DankFont.caption)
            .foregroundStyle(DankColor.Text.muted)
          Image(systemName: "chevron.up")
            .font(DankFont.caption)
            .foregroundStyle(DankColor.Text.muted)
        }
      }
      .padding(.horizontal, DankSpacing.sm)
      .padding(.vertical, DankSpacing.xs)
      .background(DankColor.cream)
      .clipShape(Capsule())
      .overlay(
        Capsule().strokeBorder(DankColor.primary.opacity(0.18), lineWidth: 1)
      )
    }
    .buttonStyle(.plain)
    .disabled(!store.isOnline)
    .opacity(store.isOnline ? 1 : 0.6)
    .accessibilityIdentifier("shift.statusPill")
  }

  // MARK: - Status menu sheet

  private var statusMenuSheet: some View {
    NavigationStack {
      VStack(spacing: DankSpacing.md) {
        VStack(spacing: DankSpacing.xs) {
          Text("Set your status")
            .font(DankFont.title)
            .foregroundStyle(DankColor.Text.primary)
          Text("Pause incoming offers without ending your shift. Dispatch will skip you until you flip back to Online.")
            .font(DankFont.bodySmall)
            .foregroundStyle(DankColor.Text.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, DankSpacing.sm)
        }

        VStack(spacing: DankSpacing.sm) {
          statusOptionButton(.online, title: "Online", description: "Accept offers in your area.")
          statusOptionButton(.onBreak, title: "On break", description: "Short pause. Driver dashboard shows you're back soon.")
          statusOptionButton(.unavailable, title: "Unavailable", description: "Soft pause. Dispatch will skip you until you flip back.")
        }

        DankButton(
          "Sign out",
          style: .ghost,
          size: .medium,
          action: onSignOut
        )
        .padding(.top, DankSpacing.md)
      }
      .padding(DankSpacing.lg)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      .background(DankColor.cream)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { store.send(.statusMenuDismissed) }
        }
      }
    }
  }

  @ViewBuilder
  private func statusOptionButton(
    _ status: SelfSettableDriverStatus,
    title: String,
    description: String
  ) -> some View {
    Button {
      store.send(.statusOptionTapped(status))
    } label: {
      HStack(alignment: .center, spacing: DankSpacing.md) {
        VStack(alignment: .leading, spacing: DankSpacing.xxs) {
          Text(title)
            .font(DankFont.headline)
            .foregroundStyle(DankColor.Text.primary)
          Text(description)
            .font(DankFont.caption)
            .foregroundStyle(DankColor.Text.secondary)
            .multilineTextAlignment(.leading)
        }
        Spacer(minLength: 0)
        if isCurrentStatus(status) {
          Image(systemName: "checkmark.circle.fill")
            .foregroundStyle(DankColor.primary)
            .accessibilityHidden(true)
        }
      }
      .padding(DankSpacing.md)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(DankColor.cream)
      .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous)
          .strokeBorder(
            isCurrentStatus(status) ? DankColor.primary : DankColor.primary.opacity(0.18),
            lineWidth: isCurrentStatus(status) ? 1.5 : 1
          )
      )
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("shift.statusMenu.\(status.rawValue)")
  }

  private func isCurrentStatus(_ status: SelfSettableDriverStatus) -> Bool {
    guard let current = store.driver?.currentStatus else { return false }
    switch (status, current) {
    case (.online, .online): return true
    case (.onBreak, .onBreak): return true
    case (.unavailable, .unavailable): return true
    default: return false
    }
  }
}

