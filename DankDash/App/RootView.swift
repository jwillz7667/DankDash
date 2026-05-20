import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashFeatures
import DankDashNetwork

/// Top-level scene. Switches on RootFeature.State.screen and mounts the
/// matching screen subtree. Children get a scoped Store so they can't
/// dispatch parent actions outside the documented Delegate surface.
struct RootView: View {
  @Bindable var store: StoreOf<RootFeature>

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
      case .signedIn:
        SignedInPlaceholderView(
          user: store.signedInUser,
          onSignOut: { store.send(.signOutTapped) }
        )
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
      DankLogo(.mark, size: 88)
      DankLoader()
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(DankColor.cream)
  }
}

private struct AuthFlowView: View {
  @Bindable var store: StoreOf<RootFeature>

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

/// Lightweight post-auth surface — Phase 17 swaps this for the catalog
/// flow. The sign-out button verifies the end-to-end auth → keychain
/// round-trip works in a dev build.
private struct SignedInPlaceholderView: View {
  let user: UserSummaryDTO?
  let onSignOut: () -> Void

  var body: some View {
    VStack(spacing: DankSpacing.lg) {
      DankLogo(.full, size: 120)

      VStack(spacing: DankSpacing.sm) {
        Text(greeting)
          .font(DankFont.title)
          .foregroundStyle(DankColor.Text.primary)
        Text("Phase 17 lights this up.")
          .font(DankFont.body)
          .foregroundStyle(DankColor.Text.muted)
      }

      DankButton("Sign out", style: .ghost, size: .medium, action: onSignOut)
    }
    .padding(DankSpacing.lg)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(DankColor.cream)
  }

  private var greeting: String {
    if let first = user?.firstName, !first.isEmpty {
      "Welcome, \(first)"
    } else {
      "Welcome"
    }
  }
}
