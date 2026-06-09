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

    public init(
      user: UserSummaryDTO? = nil,
      isLoadingProfile: Bool = false,
      profileEdit: ProfileEditFeature.State? = nil,
      addresses: AddressesFeature.State? = nil
    ) {
      self.user = user
      self.isLoadingProfile = isLoadingProfile
      self.profileEdit = profileEdit
      self.addresses = addresses
    }
  }

  public enum Action: Equatable, Sendable {
    case onAppear
    case profileLoaded(Result<UserSummaryDTO, APIErrorBox>)
    case editProfileTapped
    case profileEditDismissed
    case manageAddressesTapped
    case addressesDismissed
    case orderHistoryTapped
    case signOutTapped
    case profileEdit(ProfileEditFeature.Action)
    case addresses(AddressesFeature.Action)
    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Equatable, Sendable {
      case signOutRequested
      case showOrders
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

      case .orderHistoryTapped:
        return .send(.delegate(.showOrders))

      case .signOutTapped:
        return .send(.delegate(.signOutRequested))

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
  }
}
