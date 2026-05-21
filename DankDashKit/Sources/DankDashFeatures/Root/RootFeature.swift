import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Top-level navigation reducer. Owns one persistent State and routes
/// view rendering via a `Screen` tag:
///
///   1. `bootstrapping` — loads keychain on launch.
///   2. `ageGate` — under-21 hard gate (Minn. Stat. §342.27 forbids
///      cannabis content for minors; KYC in Phase 17 is the authority,
///      this is the client-side first-line UX guard).
///   3. `auth` — login / sign-up / forgot-password sub-flow.
///   4. `signedIn` — home placeholder; Phase 17 swaps this for the
///      catalog/cart features.
///
/// Child feature states live on the root State (not nested in the enum)
/// so they survive screen transitions and so the reducer compositions
/// stay flat — `Scope(state:action:)` rather than `ifCaseLet`. Bootstrap
/// reads `tokenStore` once to skip straight to `signedIn` for returning
/// users with valid tokens. Token presence is a proxy; the first
/// authenticated request re-validates and a 401 from the refresh-retry
/// dance brings us back to auth via the `.signOutTapped` path.
@Reducer
public struct RootFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable {
    public var screen: Screen
    public var ageGate: AgeGateFeature.State
    public var login: LoginFeature.State
    public var signUp: SignUpFeature.State
    public var forgotPassword: ForgotPasswordFeature.State?
    public var authScreen: AuthScreen
    public var signedInUser: UserSummaryDTO?
    public var browse: BrowseFeature.State

    public enum Screen: Equatable, Sendable {
      case bootstrapping
      case ageGate
      case auth
      case signedIn
    }

    public enum AuthScreen: Equatable, Sendable {
      case login
      case signUp
      case forgotPassword
    }

    public init(
      screen: Screen = .bootstrapping,
      ageGate: AgeGateFeature.State = .init(),
      login: LoginFeature.State = .init(),
      signUp: SignUpFeature.State = .init(),
      forgotPassword: ForgotPasswordFeature.State? = nil,
      authScreen: AuthScreen = .login,
      signedInUser: UserSummaryDTO? = nil,
      browse: BrowseFeature.State = .init()
    ) {
      self.screen = screen
      self.ageGate = ageGate
      self.login = login
      self.signUp = signUp
      self.forgotPassword = forgotPassword
      self.authScreen = authScreen
      self.signedInUser = signedInUser
      self.browse = browse
    }
  }

  public enum Action: Sendable {
    case onAppear
    case bootstrapResolved(hasSession: Bool)
    case ageGate(AgeGateFeature.Action)
    case authLoginScreenSelected
    case authSignUpScreenSelected
    case authForgotPasswordTapped
    case login(LoginFeature.Action)
    case signUp(SignUpFeature.Action)
    case forgotPassword(ForgotPasswordFeature.Action)
    case browse(BrowseFeature.Action)
    case signOutTapped
  }

  @Dependency(\.tokenStore) var tokens

  public init() {}

  public var body: some ReducerOf<Self> {
    Scope(state: \.ageGate, action: \.ageGate) {
      AgeGateFeature()
    }

    Scope(state: \.login, action: \.login) {
      LoginFeature()
    }

    Scope(state: \.signUp, action: \.signUp) {
      SignUpFeature()
    }

    Scope(state: \.browse, action: \.browse) {
      BrowseFeature()
    }

    Reduce { state, action in
      switch action {
      case .onAppear:
        guard case .bootstrapping = state.screen else { return .none }
        return .run { send in
          let access = await tokens.loadAccess()
          let refresh = await tokens.loadRefresh()
          let hasSession = access != nil && refresh != nil
          await send(.bootstrapResolved(hasSession: hasSession))
        }

      case .bootstrapResolved(let hasSession):
        state.screen = hasSession ? .signedIn : .ageGate
        return .none

      case .ageGate(.delegate(.passed)):
        state.screen = .auth
        return .none

      case .ageGate:
        return .none

      case .authLoginScreenSelected:
        state.authScreen = .login
        return .none

      case .authSignUpScreenSelected:
        state.authScreen = .signUp
        return .none

      case .authForgotPasswordTapped:
        state.authScreen = .forgotPassword
        state.forgotPassword = ForgotPasswordFeature.State(email: state.login.email)
        return .none

      case .login(.delegate(.authenticated(let user, _))):
        state.signedInUser = user
        state.screen = .signedIn
        return .none

      case .login:
        return .none

      case .signUp(.delegate(.registered(let user, _))):
        state.signedInUser = user
        state.screen = .signedIn
        return .none

      case .signUp:
        return .none

      case .forgotPassword(.delegate(.dismissed)):
        state.forgotPassword = nil
        state.authScreen = .login
        return .none

      case .forgotPassword:
        return .none

      case .browse:
        return .none

      case .signOutTapped:
        state.signedInUser = nil
        state.login = .init()
        state.signUp = .init()
        state.forgotPassword = nil
        state.authScreen = .login
        state.screen = .auth
        state.browse = .init()
        return .run { _ in
          await tokens.clear()
        }
      }
    }
    .ifLet(\.forgotPassword, action: \.forgotPassword) {
      ForgotPasswordFeature()
    }
  }
}
