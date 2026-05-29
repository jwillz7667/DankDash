import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// Active-delivery route surface. The driver lands here after accepting
/// an offer — top half is the live map (dispensary + drop-off + driver
/// pins), bottom half is the leg-specific card (PickupCardView while
/// heading to the dispensary, DropoffCardView once the pickup is
/// confirmed). The current turn-by-turn step is overlaid above the
/// card as a thin instruction banner whenever directions are loaded.
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
      case .enRouteToDropoff:
        DropoffCardView(
          customer: route.customer,
          address: route.dropoff,
          etaMinutes: etaMinutes,
          distanceMiles: distanceMiles,
          isArriving: false,
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
