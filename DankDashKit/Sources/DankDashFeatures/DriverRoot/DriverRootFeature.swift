import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Top-level navigation reducer for the **DankDasher** driver app.
/// Mirrors ``RootFeature`` from the consumer side but routes
/// post-auth into one of two surfaces:
///
///   1. `bootstrapping` — keychain probe on launch.
///   2. `auth` — login / sign-up / forgot-password sub-flow (reuses
///      ``LoginFeature`` / ``SignUpFeature`` / ``ForgotPasswordFeature``
///      verbatim). Drivers are vetted employees onboarded through KYC,
///      so — unlike the consumer app — there is **no** under-21 age
///      gate ahead of sign-in; a fresh launch lands straight on login.
///   3. `loadingDriver` — short-lived: post-auth, fetch the driver
///      self-projection via ``DriverAppAPIClient/getMe`` so we know
///      whether to land on onboarding or the shift home. Re-runs on
///      bootstrap when a session is restored from keychain.
///   4. `onboarding` — driver record absent (404 on `getMe`) OR present
///      but background check not yet passed → render
///      ``DriverOnboardingFeature``. Listens for the
///      `.onboardingComplete(Driver)` delegate to advance once an admin
///      flips the background-check timestamp.
///   5. `shift` — driver record exists and background check passed →
///      ``DriverShiftFeature`` (the map + online/offline + earnings
///      home).
///   6. `earnings` — pushed from ``DriverShiftFeature``'s earnings-card
///      tap; rendered as a child of `shift` so a sign-out flush still
///      reaches it.
///
/// As with the consumer root, child states live on the root `State`
/// (not inside the `Screen` enum) so they survive transitions and the
/// reducer composition stays flat via `Scope(state:action:)`. The first
/// authenticated request re-validates JWT freshness via the existing
/// Phase 16 `LiveAuthInterceptor`; a `401` from the refresh-retry dance
/// brings us back to auth through ``Action/signOutTapped``.
@Reducer
public struct DriverRootFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable {
    public var screen: Screen
    public var login: LoginFeature.State
    public var signUp: SignUpFeature.State
    public var forgotPassword: ForgotPasswordFeature.State?
    public var authScreen: AuthScreen
    public var signedInUser: UserSummaryDTO?
    public var driver: Driver?
    public var onboarding: DriverOnboardingFeature.State
    public var shift: DriverShiftFeature.State
    public var earnings: DriverEarningsFeature.State?
    public var activeRoute: ActiveRouteFeature.State?
    public var idScan: IDScanFeature.State?
    public var deliveryComplete: DeliveryCompleteFeature.State?
    public var driverLoadError: String?

    /// Parsed-but-not-yet-handled deep link. The dispatch-offer push
    /// hand-off in Phase 20 lands here via `dankdasher://offer/<id>`;
    /// Phase 19 wires the surface but the route table is empty, so
    /// every URL ends up `nil`. Held on root state so a deep link
    /// arriving during bootstrap survives the `bootstrapping → shift`
    /// transition.
    public var pendingDeepLinkURL: URL?

    public enum Screen: Equatable, Sendable {
      case bootstrapping
      case auth
      case loadingDriver
      case onboarding
      case shift
      case earnings
      case activeRoute
      case idScan
      case deliveryComplete
    }

    public enum AuthScreen: Equatable, Sendable {
      case login
      case signUp
      case forgotPassword
    }

    public init(
      screen: Screen = .bootstrapping,
      login: LoginFeature.State = .init(),
      signUp: SignUpFeature.State = .init(),
      forgotPassword: ForgotPasswordFeature.State? = nil,
      authScreen: AuthScreen = .login,
      signedInUser: UserSummaryDTO? = nil,
      driver: Driver? = nil,
      onboarding: DriverOnboardingFeature.State = .init(),
      shift: DriverShiftFeature.State = .init(),
      earnings: DriverEarningsFeature.State? = nil,
      activeRoute: ActiveRouteFeature.State? = nil,
      idScan: IDScanFeature.State? = nil,
      deliveryComplete: DeliveryCompleteFeature.State? = nil,
      driverLoadError: String? = nil,
      pendingDeepLinkURL: URL? = nil
    ) {
      self.screen = screen
      self.login = login
      self.signUp = signUp
      self.forgotPassword = forgotPassword
      self.authScreen = authScreen
      self.signedInUser = signedInUser
      self.driver = driver
      self.onboarding = onboarding
      self.shift = shift
      self.earnings = earnings
      self.activeRoute = activeRoute
      self.idScan = idScan
      self.deliveryComplete = deliveryComplete
      self.driverLoadError = driverLoadError
      self.pendingDeepLinkURL = pendingDeepLinkURL
    }
  }

  public enum Action: Sendable {
    case onAppear
    case bootstrapResolved(hasSession: Bool)

    case authLoginScreenSelected
    case authSignUpScreenSelected
    case authForgotPasswordTapped
    case login(LoginFeature.Action)
    case signUp(SignUpFeature.Action)
    case forgotPassword(ForgotPasswordFeature.Action)

    case driverLoaded(Result<Driver, DriverBootstrapErrorBox>)
    case driverLoadRetryTapped

    case onboarding(DriverOnboardingFeature.Action)
    case shift(DriverShiftFeature.Action)
    case earnings(DriverEarningsFeature.Action)
    case earningsDismissed

    case activeRoute(ActiveRouteFeature.Action)
    case idScan(IDScanFeature.Action)
    case deliveryComplete(DeliveryCompleteFeature.Action)

    /// Programmatic entry into the delivery lifecycle — fired by the
    /// dispatch-offer accept delegate (Phase 20 Commit 14) and by the
    /// `dankdasher://offer/<id>` deep-link router (same commit). Sets
    /// up ``State/activeRoute`` and flips the screen.
    case startActiveRoute(orderId: UUID)

    case signOutTapped

    /// Surface for `SwiftUI.View.onOpenURL`. Phase 19 stashes the URL
    /// without parsing — Phase 20 will introduce a
    /// `DriverDeepLinkRouter` and replace this with route parsing.
    case deepLinkReceived(URL)
    case deepLinkConsumed
  }

  @Dependency(\.tokenStore) var tokens
  @Dependency(\.driverAppAPIClient) var driverAppAPI

  public init() {}

  private enum CancelID: Hashable {
    case loadDriver
  }

  public var body: some ReducerOf<Self> {
    Scope(state: \.login, action: \.login) {
      LoginFeature()
    }

    Scope(state: \.signUp, action: \.signUp) {
      SignUpFeature()
    }

    Scope(state: \.onboarding, action: \.onboarding) {
      DriverOnboardingFeature()
    }

    Scope(state: \.shift, action: \.shift) {
      DriverShiftFeature()
    }

    Reduce { state, action in
      switch action {
      case .onAppear:
        guard case .bootstrapping = state.screen else { return .none }
        return .run { send in
          // Presence probe only — must not decrypt the biometric refresh
          // token at launch (that triggers Face ID and, without
          // NSFaceIDUsageDescription, a TCC crash). The refresh token is
          // decrypted later, on the 401-refresh path that needs its bytes.
          let hasSession = await tokens.hasSession()
          await send(.bootstrapResolved(hasSession: hasSession))
        }

      case .bootstrapResolved(let hasSession):
        if hasSession {
          state.screen = .loadingDriver
          return loadDriver()
        }
        // No age gate on the driver app — vetted employees go straight
        // to sign-in.
        state.screen = .auth
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
        state.screen = .loadingDriver
        state.driverLoadError = nil
        return loadDriver()

      case .login:
        return .none

      case .signUp(.delegate(.registered(let user, _))):
        state.signedInUser = user
        state.screen = .loadingDriver
        state.driverLoadError = nil
        return loadDriver()

      case .signUp:
        return .none

      case .forgotPassword(.delegate(.dismissed)):
        state.forgotPassword = nil
        state.authScreen = .login
        return .none

      case .forgotPassword:
        return .none

      case .driverLoaded(.success(let driver)):
        state.driver = driver
        state.driverLoadError = nil
        if driver.isBackgroundCheckPassed {
          state.shift = DriverShiftFeature.State(driver: driver)
          state.screen = .shift
          // Replay a deep link that arrived before bootstrap finished
          // (the URL handler stashes it on `pendingDeepLinkURL`). The
          // typical cold-launch case is APNs payload →
          // `dankdasher://offer/<id>` → app launches → bootstrap →
          // shift → consume offer.
          if let pending = state.pendingDeepLinkURL {
            return .send(.deepLinkReceived(pending))
          }
          return .none
        } else {
          state.onboarding = DriverOnboardingFeature.State(driver: driver)
          state.screen = .onboarding
        }
        return .none

      case .driverLoaded(.failure(let box)):
        // 404 on `GET /v1/driver/me` is the Phase 19 backend gap — the
        // user is signed in but the driver-self projection hasn't
        // landed yet. Route to onboarding so they can submit (or
        // resume) an application; the pending screen polls until an
        // admin promotes the account.
        if box.isEndpointNotYetAvailable {
          state.driver = nil
          state.driverLoadError = nil
          state.onboarding = DriverOnboardingFeature.State()
          state.screen = .onboarding
          return .none
        }
        // Real network/server failure — surface it so the user can
        // retry without losing the session.
        state.driverLoadError = box.userFacingMessage()
        return .none

      case .driverLoadRetryTapped:
        guard state.screen == .loadingDriver else { return .none }
        state.driverLoadError = nil
        return loadDriver()

      case .onboarding(.delegate(.onboardingComplete(let driver))):
        state.driver = driver
        state.shift = DriverShiftFeature.State(driver: driver)
        state.screen = .shift
        return .none

      case .onboarding:
        return .none

      case .shift(.delegate(.openEarningsDetail)):
        state.earnings = DriverEarningsFeature.State()
        state.screen = .earnings
        return .none

      case .shift(.delegate(.acceptedOffer(let orderId))):
        // Driver accepted a dispatch offer — bounce into the active
        // route lifecycle by funneling through the same entry point as
        // the deep-link router.
        return .send(.startActiveRoute(orderId: orderId))

      case .shift:
        return .none

      case .earnings(.delegate(.openShiftDetail)):
        // Phase 20 wires a shift-detail surface. For now we collapse
        // back to the earnings list — the row tap is recorded by the
        // child reducer's delegate without us pushing anywhere yet.
        return .none

      case .earnings(.delegate(.cashoutSucceeded)):
        // Wallet handles its own toast + list refresh; no root routing.
        return .none

      case .earnings:
        return .none

      case .earningsDismissed:
        state.earnings = nil
        state.screen = .shift
        return .none

      case .startActiveRoute(let orderId):
        state.activeRoute = ActiveRouteFeature.State(orderId: orderId)
        state.idScan = nil
        state.deliveryComplete = nil
        state.earnings = nil
        state.screen = .activeRoute
        return .none

      case .activeRoute(.delegate(.requestedIdScan(let orderId, let handoff))):
        state.idScan = IDScanFeature.State(
          orderId: orderId,
          idScan: handoff,
          route: state.activeRoute?.route
        )
        state.screen = .idScan
        return .none

      case .activeRoute(.delegate(.dismissed)):
        state.activeRoute = nil
        state.screen = .shift
        return .none

      case .activeRoute:
        return .none

      case .idScan(.delegate(.confirmed(let orderId, _))):
        // The driver passed the scan. Route the active-route snapshot
        // into Delivery Complete so it can show payout estimate + the
        // customer's masked name without re-fetching.
        guard let route = state.activeRoute?.route ?? state.idScan?.route else {
          state.idScan = nil
          state.activeRoute = nil
          state.screen = .shift
          return .none
        }
        state.deliveryComplete = DeliveryCompleteFeature.State(
          orderId: orderId,
          route: route
        )
        state.screen = .deliveryComplete
        return .none

      case .idScan(.delegate(.dismissed)),
           .idScan(.delegate(.escalatedContactSupport)),
           .idScan(.delegate(.escalatedReturnToDispensary)):
        state.idScan = nil
        state.activeRoute = nil
        state.deliveryComplete = nil
        state.screen = .shift
        return .none

      case .idScan:
        return .none

      case .deliveryComplete(.delegate(.completed)):
        state.deliveryComplete = nil
        state.idScan = nil
        state.activeRoute = nil
        state.screen = .shift
        // Refetch earnings so today's totals reflect the new payout —
        // the shift home's earnings card subscribes to driver state, but
        // the reducer needs an explicit kick on delivery to reload.
        return .send(.shift(.onAppear))

      case .deliveryComplete(.delegate(.dismissed)):
        state.deliveryComplete = nil
        state.idScan = nil
        state.activeRoute = nil
        state.screen = .shift
        return .none

      case .deliveryComplete(.delegate(.requiresIdScan)):
        // Defensive: backend rejected the delivery-confirm with the
        // compliance gate. Pop back to the ID-scan screen — the
        // verification fields will be re-validated on the next pass.
        state.deliveryComplete = nil
        state.screen = .idScan
        return .none

      case .deliveryComplete:
        return .none

      case .signOutTapped:
        state.signedInUser = nil
        state.driver = nil
        state.driverLoadError = nil
        state.login = .init()
        state.signUp = .init()
        state.forgotPassword = nil
        state.authScreen = .login
        state.onboarding = .init()
        state.shift = .init()
        state.earnings = nil
        state.activeRoute = nil
        state.idScan = nil
        state.deliveryComplete = nil
        state.pendingDeepLinkURL = nil
        state.screen = .auth
        return .merge(
          .cancel(id: CancelID.loadDriver),
          .run { _ in await tokens.clear() }
        )

      case .deepLinkReceived(let url):
        // Stash the URL first so a deep link arriving during
        // `bootstrapping` / `auth` survives the screen transition.
        // We dispatch the typed action below only when we can actually
        // honor the route — e.g. an `offer/<id>` URL is meaningless
        // before the driver record is loaded.
        state.pendingDeepLinkURL = url
        guard let route = DriverDeepLinkRouter.route(url) else {
          // Unknown URL — keep the stashed URL so a future router can
          // attempt to parse it again, but emit no action.
          return .none
        }
        switch route {
        case .offer(let orderId):
          // Only route if the driver is fully booted into the shift
          // surface. A cold-start offer URL with an unauthenticated
          // session is held until bootstrap completes — the post-
          // bootstrap path inspects `pendingDeepLinkURL` and re-fires.
          guard state.screen == .shift else { return .none }
          state.pendingDeepLinkURL = nil
          return .send(.startActiveRoute(orderId: orderId))
        }

      case .deepLinkConsumed:
        state.pendingDeepLinkURL = nil
        return .none
      }
    }
    .ifLet(\.forgotPassword, action: \.forgotPassword) {
      ForgotPasswordFeature()
    }
    .ifLet(\.earnings, action: \.earnings) {
      DriverEarningsFeature()
    }
    .ifLet(\.activeRoute, action: \.activeRoute) {
      ActiveRouteFeature()
    }
    .ifLet(\.idScan, action: \.idScan) {
      IDScanFeature()
    }
    .ifLet(\.deliveryComplete, action: \.deliveryComplete) {
      DeliveryCompleteFeature()
    }
  }

  // MARK: - Effect helpers

  private func loadDriver() -> Effect<Action> {
    .run { [driverAppAPI] send in
      do {
        let driver = try await driverAppAPI.getMe()
        await send(.driverLoaded(.success(driver)))
      } catch {
        await send(.driverLoaded(.failure(DriverBootstrapErrorBox(error))))
      }
    }
    .cancellable(id: CancelID.loadDriver, cancelInFlight: true)
  }
}

// MARK: - Error box

/// Equatable wrapper for `DriverRootFeature.driverLoaded` so
/// `TestStore` can pattern-match without coupling to `APIError` /
/// `DriverAPIError` / `DriverAppAPIError` cases directly. Same
/// idiom as ``ShiftErrorBox`` / ``EarningsErrorBox``.
public struct DriverBootstrapErrorBox: Error, Equatable, Sendable {
  public enum Kind: Equatable, Sendable {
    case endpointNotYetAvailable
    case malformed(String)
    case transport
    case server(message: String)
    case unauthorized
    case unimplemented(String)
    case other(String)
  }

  public let kind: Kind

  public init(_ error: Error) {
    if let appError = error as? DriverAppAPIError {
      switch appError {
      case .endpointNotYetAvailable: self.kind = .endpointNotYetAvailable
      }
      return
    }
    if let driverError = error as? DriverAPIError {
      switch driverError {
      case .malformedPayload(let label): self.kind = .malformed(label)
      case .unimplemented(let name): self.kind = .unimplemented(name)
      }
      return
    }
    if let apiError = error as? APIError {
      switch apiError {
      case .server(_, let envelope): self.kind = .server(message: envelope.error.message)
      case .transport: self.kind = .transport
      case .unauthorized, .noRefreshToken: self.kind = .unauthorized
      case .unexpectedStatus, .decoding, .configuration: self.kind = .other(String(describing: apiError))
      }
      return
    }
    self.kind = .other(String(describing: error))
  }

  public var isEndpointNotYetAvailable: Bool {
    if case .endpointNotYetAvailable = kind { return true }
    return false
  }

  public func userFacingMessage() -> String {
    switch kind {
    case .endpointNotYetAvailable: ""
    case .malformed: "Couldn't read the response. We'll try again."
    case .transport: "Couldn't reach DankDash. Check your connection."
    case .server(let message): message
    case .unauthorized: "Sign in again to continue."
    case .unimplemented: "This is not available yet."
    case .other(let message): message
    }
  }
}
