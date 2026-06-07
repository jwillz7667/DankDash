import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// Active-delivery route surface. The driver lands here after accepting
/// an offer — top half is the live map (dispensary + drop-off + driver
/// pins), bottom half is the phase-specific card: PickupCardView heading
/// to the dispensary, a handoff-wait card while the vendor confirms the
/// physical handoff, a Start-Trip card once picked up, then
/// DropoffCardView heading to the customer. The current turn-by-turn
/// step is overlaid above the card as a thin instruction banner whenever
/// directions are loaded.
///
/// The screen is the SwiftUI shell for ``ActiveRouteFeature`` — it
/// owns the `.task` / `.onDisappear` lifecycle hooks and routes
/// user taps to the reducer. The reducer's `dismissed` /
/// `requestedIdScan` delegates are consumed by ``DriverRootFeature``,
/// so this view has no direct knowledge of the next screen.
struct ActiveRouteScreen: View {
  @Bindable var store: StoreOf<ActiveRouteFeature>

  var body: some View {
    ZStack(alignment: .top) {
      DankColor.background.ignoresSafeArea()

      VStack(spacing: 0) {
        mapSection
          .frame(maxWidth: .infinity, maxHeight: .infinity)

        bottomCard
          .padding(.horizontal, DankSpacing.md)
          .padding(.bottom, DankSpacing.md)
      }

      VStack(spacing: DankSpacing.sm) {
        if let banner = store.errorBanner {
          errorBanner(banner)
            .padding(.horizontal, DankSpacing.md)
            .padding(.top, DankSpacing.sm)
        }
        if let step = store.currentStep {
          stepBanner(step)
            .padding(.horizontal, DankSpacing.md)
        }
        Spacer(minLength: 0)
      }
    }
    .overlay(alignment: .topLeading) {
      backButton
        .padding(.leading, DankSpacing.md)
        .padding(.top, DankSpacing.xs)
    }
    .task { store.send(.onAppear) }
    .onDisappear { store.send(.onDisappear) }
  }

  // MARK: - Map

  @ViewBuilder
  private var mapSection: some View {
    if let route = store.route {
      LiveMapView(
        dispensary: LiveMapView.Pin(
          id: "dispensary",
          kind: .dispensary,
          coordinate: route.dispensary.location,
          title: route.dispensary.name
        ),
        customer: LiveMapView.Pin(
          id: "customer",
          kind: .customer,
          coordinate: route.dropoff.location,
          title: route.customer.displayName
        ),
        driver: store.driverLocation.map { coord in
          LiveMapView.Pin(
            id: "driver",
            kind: .driver,
            coordinate: coord,
            title: "You"
          )
        }
      )
      .padding(DankSpacing.md)
    } else {
      VStack(spacing: DankSpacing.md) {
        DankLoader()
        Text(store.isLoadingRoute ? "Loading delivery…" : "Couldn't load delivery")
          .font(DankFont.body)
          .foregroundStyle(DankColor.Text.secondary)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }

  // MARK: - Bottom card

  @ViewBuilder
  private var bottomCard: some View {
    if let route = store.route {
      switch store.phase {
      case .enRouteToPickup:
        PickupCardView(
          dispensary: route.dispensary,
          etaMinutes: etaMinutes,
          distanceMiles: distanceMiles,
          isConfirming: store.confirmPickupInFlight,
          onConfirm: { store.send(.confirmPickupTapped) }
        )
      case .awaitingHandoff:
        handoffWaitCard(route)
      case .readyToDepart:
        departCard(route)
      case .enRouteToDropoff:
        DropoffCardView(
          customer: route.customer,
          address: route.dropoff,
          etaMinutes: etaMinutes,
          distanceMiles: distanceMiles,
          isArriving: store.arriveInFlight,
          onArrived: { store.send(.arrivedTapped) }
        )
      case .awaitingIdScan, .completed:
        EmptyView()
      }
    } else if !store.isLoadingRoute {
      Button {
        store.send(.retryTapped)
      } label: {
        Text("Try again")
          .font(DankFont.headline)
          .foregroundStyle(DankColor.Text.onPrimary)
          .frame(maxWidth: .infinity, minHeight: 52)
          .background(DankColor.primary)
          .clipShape(Capsule())
      }
    }
  }

  /// Shown while the order sits at `en_route_pickup` waiting for the
  /// vendor to confirm the physical handoff (`picked_up`). No CTA — the
  /// reducer flips to ``ActiveRouteFeature/LocalPhase/readyToDepart`` the
  /// instant the handoff is observed over the socket or the poll.
  private func handoffWaitCard(_ route: ActiveRoute) -> some View {
    VStack(alignment: .leading, spacing: DankSpacing.sm) {
      HStack(alignment: .center, spacing: DankSpacing.sm) {
        Image(systemName: "shippingbox.fill")
          .font(DankFont.headline)
          .foregroundStyle(DankColor.primary)
          .frame(width: 28, height: 28)
        VStack(alignment: .leading, spacing: 2) {
          Text("Waiting for handoff")
            .font(DankFont.headline)
            .foregroundStyle(DankColor.Text.onBackground)
          Text(route.dispensary.name)
            .font(DankFont.bodySmall)
            .foregroundStyle(DankColor.Text.secondary)
        }
        Spacer(minLength: 0)
        ProgressView()
          .progressViewStyle(.circular)
          .tint(DankColor.primary)
      }
      Text("The pickup unlocks the moment staff confirm the handoff in their portal.")
        .font(DankFont.bodySmall)
        .foregroundStyle(DankColor.Text.muted)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(DankSpacing.lg)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(DankColor.background)
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous)
        .strokeBorder(DankColor.primary.opacity(0.12), lineWidth: 1)
    )
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Waiting for \(route.dispensary.name) to hand off the order")
  }

  /// Shown at `picked_up`: the bag is in the car. The driver taps Start
  /// Trip to fire `depart` (→ `en_route_dropoff`) and begin navigating to
  /// the customer.
  private func departCard(_ route: ActiveRoute) -> some View {
    VStack(alignment: .leading, spacing: DankSpacing.md) {
      HStack(alignment: .top, spacing: DankSpacing.sm) {
        Image(systemName: "checkmark.seal.fill")
          .font(DankFont.headline)
          .foregroundStyle(DankColor.Semantic.success)
          .frame(width: 28, height: 28)
        VStack(alignment: .leading, spacing: 2) {
          Text("Order picked up")
            .font(DankFont.headline)
            .foregroundStyle(DankColor.Text.onBackground)
          Text("Deliver to \(route.customer.displayName)")
            .font(DankFont.bodySmall)
            .foregroundStyle(DankColor.Text.secondary)
        }
        Spacer(minLength: 0)
      }
      Text(route.dropoff.oneLine)
        .font(DankFont.body)
        .foregroundStyle(DankColor.Text.secondary)
        .multilineTextAlignment(.leading)
        .accessibilityLabel("Drop-off address: \(route.dropoff.oneLine)")
      departButton(route)
    }
    .padding(DankSpacing.lg)
    .background(DankColor.background)
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous)
        .strokeBorder(DankColor.primary.opacity(0.12), lineWidth: 1)
    )
  }

  private func departButton(_ route: ActiveRoute) -> some View {
    Button {
      store.send(.departTapped)
    } label: {
      ZStack {
        Text("Start Trip")
          .font(DankFont.headline)
          .foregroundStyle(DankColor.Text.onPrimary)
          .opacity(store.departInFlight ? 0 : 1)
        if store.departInFlight {
          ProgressView()
            .progressViewStyle(.circular)
            .tint(DankColor.Text.onPrimary)
        }
      }
      .frame(maxWidth: .infinity, minHeight: 52)
      .background(DankColor.primary)
      .clipShape(Capsule())
    }
    .disabled(store.departInFlight)
    .accessibilityLabel("Start trip to \(route.customer.displayName)")
  }

  private var etaMinutes: Int? {
    guard let secs = store.directions?.expectedTravelTimeSeconds else { return nil }
    return max(1, Int((secs / 60).rounded()))
  }

  private var distanceMiles: Decimal? {
    guard let meters = store.directions?.distanceMeters else { return nil }
    let miles = meters / 1609.344
    return Decimal(miles)
  }

  // MARK: - Top overlays

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
  }

  private func stepBanner(_ step: RouteStep) -> some View {
    HStack(alignment: .center, spacing: DankSpacing.sm) {
      Image(systemName: "arrow.turn.up.right")
        .font(DankFont.headline)
        .foregroundStyle(DankColor.primary)
      VStack(alignment: .leading, spacing: 2) {
        Text(step.instruction)
          .font(DankFont.body)
          .foregroundStyle(DankColor.Text.onBackground)
          .lineLimit(2)
        if let notice = step.notice, !notice.isEmpty {
          Text(notice)
            .font(DankFont.caption)
            .foregroundStyle(DankColor.Text.muted)
            .lineLimit(1)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(DankSpacing.sm)
    .background(DankColor.background)
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous)
        .strokeBorder(DankColor.primary.opacity(0.18), lineWidth: 1)
    )
    .shadow(color: DankColor.Text.primary.opacity(0.08), radius: 6, x: 0, y: 2)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Next step: \(step.instruction)")
  }

  private var backButton: some View {
    Button {
      store.send(.backTapped)
    } label: {
      Image(systemName: "chevron.left")
        .font(DankFont.headline)
        .foregroundStyle(DankColor.Text.onBackground)
        .padding(DankSpacing.sm)
        .background(DankColor.background.opacity(0.9))
        .clipShape(Circle())
        .shadow(color: DankColor.Text.primary.opacity(0.08), radius: 4, x: 0, y: 1)
    }
    .accessibilityLabel("Back to shift")
  }
}
