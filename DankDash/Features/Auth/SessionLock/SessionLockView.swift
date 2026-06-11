import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashFeatures

/// Launch-time session gate: a stored session exists and the user must
/// pass Face ID / device authentication before it unlocks. The reducer
/// auto-attempts on appear, so the happy path is one Face ID glance —
/// the buttons only matter after a canceled or failed prompt.
struct SessionLockView: View {
  @Bindable var store: StoreOf<SessionLockFeature>

  var body: some View {
    VStack(spacing: DankSpacing.lg) {
      Spacer()

      DankLogo(.mark, size: 96)

      VStack(spacing: DankSpacing.sm) {
        Text("Welcome back")
          .font(DankFont.title)
          .foregroundStyle(DankColor.Text.primary)
        Text("Unlock to pick up where you left off.")
          .font(DankFont.body)
          .foregroundStyle(DankColor.Text.secondary)
          .multilineTextAlignment(.center)
      }
      .padding(.horizontal, DankSpacing.lg)

      if let message = store.failureMessage {
        Text(message)
          .font(DankFont.caption)
          .foregroundStyle(DankColor.Semantic.danger)
          .multilineTextAlignment(.center)
          .padding(.horizontal, DankSpacing.lg)
      }

      Spacer()

      VStack(spacing: DankSpacing.sm) {
        DankButton(
          "Unlock with Face ID",
          style: .primary,
          size: .large,
          isLoading: store.isUnlocking,
          action: { store.send(.unlockTapped) }
        )
        DankButton(
          "Sign in with a different account",
          style: .ghost,
          size: .medium,
          action: { store.send(.signOutTapped) }
        )
      }
      .padding(.horizontal, DankSpacing.lg)
      .padding(.bottom, DankSpacing.xl)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(DankColor.cream)
    .task { store.send(.onAppear) }
  }
}
