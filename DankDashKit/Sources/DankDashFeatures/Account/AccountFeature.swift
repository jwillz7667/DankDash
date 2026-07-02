import Foundation
import ComposableArchitecture
import DankDashNetwork

/// Account-tab hub. Owns the signed-in user's profile (fetched from
/// `/v1/me` on appearance — the tab is the authoritative source for the
/// identity card rather than threading it down from the root) and the
/// optional edit-profile child.
///
/// Cross-tab and sign-out concerns flow up via `Delegate`: the actual
/// token clear + screen reset belongs to ``RootFeature``, and switching
/// to the Orders tab belongs to ``BrowseFeature``.
@Reducer
public struct AccountFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable {
    public var user: UserSummaryDTO?
    public var isLoadingProfile: Bool
    public var profileEdit: ProfileEditFeature.State?
    public var addresses: AddressesFeature.State?
    public var paymentMethods: PaymentMethodsFeature.State?
    public var notifications: NotificationPreferencesFeature.State?
    public var favorites: FavoritesFeature.State?
    /// Drives the destructive "Delete account?" confirmation alert.
    public var isConfirmingAccountDeletion: Bool
    /// True while the `DELETE /v1/me` request is in flight; disables the
    /// row + sign-out so the user can't double-submit or race a sign-out
    /// against the deletion.
    public var isDeletingAccount: Bool
    /// User-facing copy for a failed deletion (e.g. the 409 "active order"
    /// case); cleared when a fresh attempt starts.
    public var deleteAccountError: String?

    public init(
      user: UserSummaryDTO? = nil,
      isLoadingProfile: Bool = false,
      profileEdit: ProfileEditFeature.State? = nil,
      addresses: AddressesFeature.State? = nil,
      paymentMethods: PaymentMethodsFeature.State? = nil,
      notifications: NotificationPreferencesFeature.State? = nil,
      favorites: FavoritesFeature.State? = nil,
      isConfirmingAccountDeletion: Bool = false,
      isDeletingAccount: Bool = false,
      deleteAccountError: String? = nil
    ) {
      self.user = user
      self.isLoadingProfile = isLoadingProfile
      self.profileEdit = profileEdit
      self.addresses = addresses
      self.paymentMethods = paymentMethods
      self.notifications = notifications
      self.favorites = favorites
      self.isConfirmingAccountDeletion = isConfirmingAccountDeletion
      self.isDeletingAccount = isDeletingAccount
      self.deleteAccountError = deleteAccountError
    }
  }

  public enum Action: Equatable, Sendable {
    case onAppear
    case profileLoaded(Result<UserSummaryDTO, APIErrorBox>)
    case editProfileTapped
    case profileEditDismissed
    case manageAddressesTapped
    case addressesDismissed
    case managePaymentMethodsTapped
    case paymentMethodsDismissed
    case manageNotificationsTapped
    case notificationsDismissed
    case favoritesTapped
    case favoritesDismissed
    case orderHistoryTapped
    case signOutTapped
    case deleteAccountTapped
    case deleteAccountCanceled
    case deleteAccountConfirmed
    case accountDeletionFailed(APIErrorBox)
    case profileEdit(ProfileEditFeature.Action)
    case addresses(AddressesFeature.Action)
    case paymentMethods(PaymentMethodsFeature.Action)
    case notifications(NotificationPreferencesFeature.Action)
    case favorites(FavoritesFeature.Action)
    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Equatable, Sendable {
      case signOutRequested
      case showOrders
      /// The server confirmed the account is deleted. The root tears down
      /// the session (clear tokens, reset to the signed-out screen) exactly
      /// as it does for sign-out — there is nothing left to stay signed into.
      case accountDeletionCompleted
    }
  }

  @Dependency(\.meAPIClient) var meAPIClient

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .onAppear:
        // Refresh on every appearance; only show the loader when we have
        // nothing to render yet, so a re-entry doesn't flicker the card.
        if state.user == nil { state.isLoadingProfile = true }
        return .run { [meAPIClient] send in
          do {
            let user = try await meAPIClient.getProfile()
            await send(.profileLoaded(.success(user)))
          } catch {
            await send(.profileLoaded(.failure(APIErrorBox(error))))
          }
        }

      case .profileLoaded(.success(let user)):
        state.isLoadingProfile = false
        state.user = user
        return .none

      case .profileLoaded(.failure):
        // Non-fatal: keep whatever identity we already had. The next
        // authenticated request re-validates the session; a genuinely
        // expired token surfaces as a 401 and the refresh-retry path
        // routes back to auth.
        state.isLoadingProfile = false
        return .none

      case .editProfileTapped:
        guard let user = state.user else { return .none }
        state.profileEdit = ProfileEditFeature.State(
          firstName: user.firstName ?? "",
          lastName: user.lastName ?? "",
          email: user.email
        )
        return .none

      case .profileEditDismissed:
        state.profileEdit = nil
        return .none

      case .manageAddressesTapped:
        state.addresses = AddressesFeature.State()
        return .none

      case .addressesDismissed:
        state.addresses = nil
        return .none

      case .managePaymentMethodsTapped:
        state.paymentMethods = PaymentMethodsFeature.State()
        return .none

      case .paymentMethodsDismissed:
        state.paymentMethods = nil
        return .none

      case .manageNotificationsTapped:
        state.notifications = NotificationPreferencesFeature.State()
        return .none

      case .notificationsDismissed:
        state.notifications = nil
        return .none

      case .favoritesTapped:
        state.favorites = FavoritesFeature.State()
        return .none

      case .favoritesDismissed:
        state.favorites = nil
        return .none

      case .orderHistoryTapped:
        return .send(.delegate(.showOrders))

      case .signOutTapped:
        // A deletion in flight owns the teardown path; don't let a stray
        // sign-out tap race it.
        guard !state.isDeletingAccount else { return .none }
        return .send(.delegate(.signOutRequested))

      case .deleteAccountTapped:
        guard !state.isDeletingAccount else { return .none }
        state.deleteAccountError = nil
        state.isConfirmingAccountDeletion = true
        return .none

      case .deleteAccountCanceled:
        state.isConfirmingAccountDeletion = false
        return .none

      case .deleteAccountConfirmed:
        guard !state.isDeletingAccount else { return .none }
        state.isConfirmingAccountDeletion = false
        state.isDeletingAccount = true
        state.deleteAccountError = nil
        return .run { [meAPIClient] send in
          do {
            try await meAPIClient.deleteAccount()
            // On success the account no longer exists; hand off to the root
            // for token clear + screen reset. We deliberately do not flip
            // `isDeletingAccount` back — the whole browse subtree is about
            // to be discarded by `resetToSignedOut`.
            await send(.delegate(.accountDeletionCompleted))
          } catch {
            await send(.accountDeletionFailed(APIErrorBox(error)))
          }
        }

      case .accountDeletionFailed(let error):
        state.isDeletingAccount = false
        state.deleteAccountError = error.userFacingMessage(
          default: "We couldn't delete your account. Please try again."
        )
        return .none

      case .profileEdit(.delegate(.saved(let user))):
        state.user = user
        state.profileEdit = nil
        return .none

      case .profileEdit(.delegate(.cancelled)):
        state.profileEdit = nil
        return .none

      case .profileEdit:
        return .none

      case .addresses:
        return .none

      case .paymentMethods:
        return .none

      case .notifications:
        return .none

      case .favorites:
        return .none

      case .delegate:
        return .none
      }
    }
    .ifLet(\.profileEdit, action: \.profileEdit) {
      ProfileEditFeature()
    }
    .ifLet(\.addresses, action: \.addresses) {
      AddressesFeature()
    }
    .ifLet(\.paymentMethods, action: \.paymentMethods) {
      PaymentMethodsFeature()
    }
    .ifLet(\.notifications, action: \.notifications) {
      NotificationPreferencesFeature()
    }
    .ifLet(\.favorites, action: \.favorites) {
      FavoritesFeature()
    }
  }
}
