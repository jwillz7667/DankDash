import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashFeatures

/// Top-level scene for the DankDasher driver app. Switches on
/// ``DriverRootFeature/State/screen`` and mounts the matching subtree.
/// Children get a scoped `Store` so they can't dispatch parent actions
/// outside the documented `Delegate` surface — same idiom as the
/// consumer's `RootView`.
///
/// Phase 20 added the delivery lifecycle: `activeRoute → idScan →
/// deliveryComplete`. Each branch mounts the matching feature's screen
/// and the parent reducer handles all routing via delegate actions, so
/// the view layer stays a pure projection of `state.screen`.
struct RootView: View {
  @Bindable var store: StoreOf<DriverRootFeature>

  var body: some View {
    Group {
      switch store.screen {
      case .bootstrapping:
        BootstrapView()

      case .ageGate:
        AgeGateView(
          store: store.scope(state: \.ageGate, action: \.ageGate)
        )

      case .auth:
        AuthFlowView(store: store)

      case .loadingDriver:
        DriverBootstrapView(
          errorMessage: store.driverLoadError,
          onRetry: { store.send(.driverLoadRetryTapped) },
          onSignOut: { store.send(.signOutTapped) }
        )

      case .onboarding:
        OnboardingFlowView(
          store: store.scope(state: \.onboarding, action: \.onboarding),
          onSignOut: { store.send(.signOutTapped) }
        )

      case .shift:
        ShiftHomeView(
          store: store.scope(state: \.shift, action: \.shift),
          onSignOut: { store.send(.signOutTapped) }
        )

      case .earnings:
        if let earningsStore = store.scope(state: \.earnings, action: \.earnings) {
          EarningsWalletScreen(
            store: earningsStore,
            onDismiss: { store.send(.earningsDismissed) }
          )
        } else {
          DankLoader()
        }

      case .activeRoute:
        if let activeRouteStore = store.scope(state: \.activeRoute, action: \.activeRoute) {
          ActiveRouteScreen(store: activeRouteStore)
        } else {
          DankLoader()
        }

      case .idScan:
        if let idScanStore = store.scope(state: \.idScan, action: \.idScan) {
          IDScanScreen(store: idScanStore)
        } else {
          DankLoader()
        }

      case .deliveryComplete:
        if let deliveryStore = store.scope(state: \.deliveryComplete, action: \.deliveryComplete) {
          DeliveryCompleteScreen(store: deliveryStore)
        } else {
          DankLoader()
        }
      }
    }
    .background(DankColor.cream.ignoresSafeArea())
    .task {
      store.send(.onAppear)
    }
  }
}

private struct BootstrapView: View {
  var body: some View {
    VStack(spacing: DankSpacing.md) {
      DankLogo(.mark, size: 64)
      DankLoader()
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(DankColor.cream)
  }
}

/// Shown while ``DriverAppAPIClient/getMe`` is in flight after auth or
/// during bootstrap. Surfaces the retry CTA on a real network failure
/// (a 404 is interpreted as "no driver record yet" and short-circuits
/// to onboarding by the reducer — no view ever sees that branch).
private struct DriverBootstrapView: View {
  let errorMessage: String?
  let onRetry: () -> Void
  let onSignOut: () -> Void

  var body: some View {
    VStack(spacing: DankSpacing.lg) {
      DankLogo(.mark, size: 64)
      if let message = errorMessage {
        VStack(spacing: DankSpacing.sm) {
          Text("Couldn't load your driver profile")
            .font(DankFont.headline)
            .foregroundStyle(DankColor.Text.primary)
          Text(message)
            .font(DankFont.body)
            .foregroundStyle(DankColor.Text.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, DankSpacing.lg)
        }
        DankButton(
          "Try again",
          style: .primary,
          size: .large,
          action: onRetry
        )
        DankButton(
          "Sign out",
          style: .ghost,
          size: .medium,
          action: onSignOut
        )
      } else {
        DankLoader()
        Text("Loading your dashboard")
          .font(DankFont.body)
          .foregroundStyle(DankColor.Text.muted)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(DankColor.cream)
  }
}

private struct AuthFlowView: View {
  @Bindable var store: StoreOf<DriverRootFeature>

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        switch store.authScreen {
        case .login:
          LoginView(
            store: store.scope(state: \.login, action: \.login),
            onSignUpTapped: { store.send(.authSignUpScreenSelected) },
            onForgotPasswordTapped: { store.send(.authForgotPasswordTapped) }
          )
        case .signUp:
          SignUpView(
            store: store.scope(state: \.signUp, action: \.signUp),
            onLoginTapped: { store.send(.authLoginScreenSelected) }
          )
        case .forgotPassword:
          if let forgotStore = store.scope(state: \.forgotPassword, action: \.forgotPassword) {
            ForgotPasswordView(store: forgotStore)
          } else {
            DankLoader()
          }
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      .background(DankColor.cream)
    }
  }
}

/// Router for the driver onboarding flow. Mounts one of five
/// per-step views — `WelcomeView`, `VehicleDetailsView`,
/// `DocumentsView`, `ReviewView`, `PendingReviewView` — depending on
/// the scoped reducer's `step`. Each child receives a `@Bindable`
/// store scoped down to `DriverOnboardingFeature` so it can dispatch
/// step-local actions; the `onSignOut` closure is the only
/// parent-action escape hatch (delegates the actual sign-out to the
/// root reducer). Triggers `.onAppear` once on mount so the draft
/// store hydrates the form fields on a cold relaunch.
private struct OnboardingFlowView: View {
  @Bindable var store: StoreOf<DriverOnboardingFeature>
  let onSignOut: () -> Void

  var body: some View {
    Group {
      switch store.step {
      case .welcome:
        WelcomeView(store: store, onSignOut: onSignOut)
      case .vehicle:
        VehicleDetailsView(store: store)
      case .documents:
        DocumentsView(store: store)
      case .review:
        ReviewView(store: store)
      case .pending:
        PendingReviewView(store: store, onSignOut: onSignOut)
      }
    }
    .task { store.send(.onAppear) }
  }
}

