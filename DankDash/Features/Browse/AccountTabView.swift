import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashFeatures
import DankDashNetwork

/// Root of the Account tab. Hosts the navigation stack that presents the
/// ``AccountHubView`` and pushes ``ProfileEditView`` when
/// ``AccountFeature/State/profileEdit`` is non-nil. Mirrors the
/// ``OrdersTabView`` pattern: the tab view takes the whole
/// ``BrowseFeature`` store so it can both scope the hub and read the
/// grandchild navigation state.
struct AccountTabView: View {
  @Bindable var store: StoreOf<BrowseFeature>

  var body: some View {
    NavigationStack {
      AccountHubView(
        store: store.scope(state: \.account, action: \.account)
      )
      .navigationDestination(
        isPresented: Binding(
          get: { store.account.profileEdit != nil },
          set: { isPresented in
            if !isPresented { store.send(.account(.profileEditDismissed)) }
          }
        )
      ) {
        if let editStore = store.scope(state: \.account.profileEdit, action: \.account.profileEdit) {
          ProfileEditView(store: editStore)
        }
      }
      .navigationDestination(
        isPresented: Binding(
          get: { store.account.addresses != nil },
          set: { isPresented in
            if !isPresented { store.send(.account(.addressesDismissed)) }
          }
        )
      ) {
        if let addressesStore = store.scope(state: \.account.addresses, action: \.account.addresses) {
          AddressesView(store: addressesStore)
        }
      }
      .navigationDestination(
        isPresented: Binding(
          get: { store.account.paymentMethods != nil },
          set: { isPresented in
            if !isPresented { store.send(.account(.paymentMethodsDismissed)) }
          }
        )
      ) {
        if let paymentStore = store.scope(
          state: \.account.paymentMethods,
          action: \.account.paymentMethods
        ) {
          PaymentMethodsView(store: paymentStore)
        }
      }
      .navigationDestination(
        isPresented: Binding(
          get: { store.account.notifications != nil },
          set: { isPresented in
            if !isPresented { store.send(.account(.notificationsDismissed)) }
          }
        )
      ) {
        if let notificationsStore = store.scope(
          state: \.account.notifications,
          action: \.account.notifications
        ) {
          NotificationPreferencesView(store: notificationsStore)
        }
      }
    }
  }
}

/// Account tab content: the signed-in identity card plus the live account
/// actions (edit profile, order history, sign out). In DEBUG, a
/// long-press on the version label opens the Design Gallery.
struct AccountHubView: View {
  @Bindable var store: StoreOf<AccountFeature>

  #if DEBUG
  @State private var galleryShown = false
  #endif

  var body: some View {
    ScrollView {
      VStack(spacing: DankSpacing.lg) {
        identityCard

        VStack(spacing: DankSpacing.sm) {
          AccountRow(
            icon: "person.crop.circle",
            title: "Edit profile",
            subtitle: "Update the name shown on your orders.",
            isEnabled: store.user != nil,
            action: { store.send(.editProfileTapped) }
          )
          AccountRow(
            icon: "mappin.and.ellipse",
            title: "Saved addresses",
            subtitle: "Manage delivery addresses and your default.",
            action: { store.send(.manageAddressesTapped) }
          )
          AccountRow(
            icon: "creditcard",
            title: "Payment methods",
            subtitle: "Link a bank account and set your default.",
            action: { store.send(.managePaymentMethodsTapped) }
          )
          AccountRow(
            icon: "bell",
            title: "Notifications",
            subtitle: "Choose which alerts you get and how they reach you.",
            action: { store.send(.manageNotificationsTapped) }
          )
          AccountRow(
            icon: "clock.arrow.circlepath",
            title: "Order history",
            subtitle: "Track every order, including delivered and cancelled.",
            action: { store.send(.orderHistoryTapped) }
          )
        }

        Spacer(minLength: DankSpacing.lg)
        DankButton("Sign out", style: .ghost, size: .medium) {
          store.send(.signOutTapped)
        }
        versionFooter
      }
      .padding(DankSpacing.lg)
    }
    .background(DankColor.cream.ignoresSafeArea())
    .navigationTitle("Account")
    .navigationBarTitleDisplayMode(.inline)
    .task { store.send(.onAppear) }
    #if DEBUG
    .sheet(isPresented: $galleryShown) {
      DesignGalleryView()
    }
    #endif
  }

  private var identityCard: some View {
    DankCard {
      HStack(alignment: .center, spacing: DankSpacing.md) {
        ZStack {
          Circle()
            .fill(DankColor.primary.opacity(0.15))
            .frame(width: 56, height: 56)
          Text(initials)
            .font(DankFont.headline)
            .foregroundStyle(DankColor.primary)
            .accessibilityHidden(true)
        }
        VStack(alignment: .leading, spacing: DankSpacing.xxs) {
          Text(displayName)
            .font(DankFont.headline)
            .foregroundStyle(DankColor.Text.primary)
          if let email = store.user?.email {
            Text(email)
              .font(DankFont.bodySmall)
              .foregroundStyle(DankColor.Text.secondary)
          } else if store.isLoadingProfile {
            DankLoader()
          }
        }
        Spacer(minLength: 0)
      }
    }
  }

  private var versionFooter: some View {
    let text = Text(versionString)
      .font(DankFont.caption)
      .foregroundStyle(DankColor.Text.muted)

    #if DEBUG
    return text.onLongPressGesture(minimumDuration: 1.0) {
      galleryShown = true
    }
    #else
    return text
    #endif
  }

  private var displayName: String {
    let first = store.user?.firstName ?? ""
    let last = store.user?.lastName ?? ""
    let combined = "\(first) \(last)".trimmingCharacters(in: .whitespaces)
    return combined.isEmpty ? "Your account" : combined
  }

  private var initials: String {
    let chars = displayName
      .split(separator: " ")
      .prefix(2)
      .compactMap { $0.first.map(String.init) }
    return chars.joined().uppercased().nonEmptyOr("D")
  }

  private var versionString: String {
    let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0"
    let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0"
    return "DankDash \(version) (\(build))"
  }
}

/// Tappable account-settings row — leading icon, title, supporting copy,
/// trailing chevron. Disabled rows dim and stop accepting taps (used while
/// the profile is still loading).
struct AccountRow: View {
  let icon: String
  let title: String
  let subtitle: String
  var isEnabled: Bool = true
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: DankSpacing.sm) {
        Image(systemName: icon)
          .font(.system(size: 18, weight: .semibold))
          .foregroundStyle(DankColor.primary)
          .frame(width: 32, height: 32)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: DankSpacing.xxs) {
          Text(title)
            .font(DankFont.body.weight(.semibold))
            .foregroundStyle(DankColor.Text.primary)
          Text(subtitle)
            .font(DankFont.bodySmall)
            .foregroundStyle(DankColor.Text.secondary)
            .multilineTextAlignment(.leading)
        }
        Spacer(minLength: 0)
        Image(systemName: "chevron.right")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(DankColor.Text.muted)
          .accessibilityHidden(true)
      }
      .padding(DankSpacing.sm)
      .background(DankColor.primary.opacity(0.04))
      .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!isEnabled)
    .opacity(isEnabled ? 1 : 0.5)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(title). \(subtitle)")
    .accessibilityAddTraits(.isButton)
  }
}

private extension String {
  func nonEmptyOr(_ fallback: String) -> String {
    isEmpty ? fallback : self
  }
}
