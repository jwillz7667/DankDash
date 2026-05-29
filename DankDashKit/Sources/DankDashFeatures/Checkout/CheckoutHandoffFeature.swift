import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Sheet-mounted reducer the cart presents when the user taps
/// "Continue to checkout — opens in Safari". Owns the entire Apple §10.4
/// hand-off lifecycle: ask the server for a one-shot token, hand it to
/// `SFSafariViewController`, wait for `checkout-web` to redirect back via
/// `dankdash://order/complete?orderId=<UUID>`.
///
/// State machine (matches the plan's "idle → requesting → ready → safari
/// → awaitDeepLink → completed|failed"):
///
/// ```
/// idle ──onAppear──▶ requesting ──handoffReceived──┬──▶ readyToOpen
///                          │                       └──▶ failed
///                          ◄──retryTapped─── failed
///   readyToOpen ──safariOpened──▶ awaitingDeepLink
///   awaitingDeepLink ──deepLinkReceived──▶ completed (emits delegate)
///   awaitingDeepLink ──safariDismissed──▶ idle (user can retry by
///                                              tapping checkout again)
/// ```
///
/// The reducer NEVER opens the Safari URL itself — the view layer owns
/// `SFSafariViewController` and dispatches `.safariOpened` /
/// `.safariDismissed` as lifecycle events. This keeps `SafariServices`
/// out of `DankDashFeatures` and matches the rule "only the app target
/// imports `SafariServices`".
@Reducer
public struct CheckoutHandoffFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable {
    public let cartId: UUID
    public let deliveryAddressId: UUID
    public var status: Status

    public init(
      cartId: UUID,
      deliveryAddressId: UUID,
      status: Status = .idle
    ) {
      self.cartId = cartId
      self.deliveryAddressId = deliveryAddressId
      self.status = status
    }

    /// `true` when the view should show a spinner. Read by `CartView`'s
    /// sheet content to render the loading state.
    public var isRequesting: Bool {
      if case .requesting = status { return true }
      return false
    }

    /// The token to hand to `SFSafariViewController`. `nil` outside the
    /// "have a token" window — the view conditionally presents Safari
    /// only when this is non-nil.
    public var presentableToken: HandoffToken? {
      switch status {
      case .readyToOpen(let token), .awaitingDeepLink(let token):
        return token
      default:
        return nil
      }
    }

    /// User-facing failure copy for the error banner. `nil` when not in
    /// `.failed`.
    public var failureMessage: String? {
      guard case .failed(let reason) = status else { return nil }
      return reason.message
    }
  }

  public enum Status: Equatable, Sendable {
    case idle
    case requesting
    case readyToOpen(HandoffToken)
    case awaitingDeepLink(HandoffToken)
    case completed(orderId: UUID)
    case failed(FailureReason)
  }

  /// Recoverable failure shapes. `tokenExpired` is treated separately
  /// from a generic network failure so the view can show a tailored
  /// "session expired — start checkout again" copy without re-hitting
  /// the API.
  public enum FailureReason: Equatable, Sendable {
    case requestFailed(String)
    case tokenExpired

    public var message: String {
      switch self {
      case .requestFailed(let copy):
        return copy
      case .tokenExpired:
        return "Your checkout session expired. Tap retry to start over."
      }
    }
  }

  public enum Action: Sendable {
    case onAppear
    case handoffReceived(Result<HandoffToken, EquatableError>)

    /// View lifecycle: `SFSafariViewController` was presented with the
    /// token's `exchangeUrl`. Reducer transitions from `.readyToOpen` to
    /// `.awaitingDeepLink`.
    case safariOpened

    /// View lifecycle: user dismissed Safari without completing
    /// checkout. Reducer drops back to `.idle` so they can retry by
    /// tapping the cart's CTA again.
    case safariDismissed

    /// Routed in from `RootFeature` after `DeepLinkRouter` matched
    /// `dankdash://order/complete?orderId=<UUID>`. Terminal happy path.
    case deepLinkReceived(orderId: UUID)

    case retryTapped
    case dismissTapped

    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Sendable, Equatable {
      case completed(orderId: UUID)
      case dismissed
    }
  }

  @Dependency(\.handoffAPIClient) var handoffAPIClient
  @Dependency(\.date.now) var now

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .onAppear:
        // Idempotent: re-appearing while a request is in flight or after
        // the token is in hand must not double-fire.
        guard case .idle = state.status else { return .none }
        return beginHandoffRequest(state: &state)

      case .handoffReceived(.success(let token)):
        // Server may legally return a token that's already past its TTL
        // if the client/server clocks drift; treat that as `tokenExpired`
        // rather than blindly handing an expired token to Safari (the
        // exchange would 401 anyway).
        guard !token.isExpired(asOf: now) else {
          state.status = .failed(.tokenExpired)
          return .none
        }
        state.status = .readyToOpen(token)
        return .none

      case .handoffReceived(.failure(let err)):
        state.status = .failed(.requestFailed(err.message))
        return .none

      case .safariOpened:
        guard case .readyToOpen(let token) = state.status else { return .none }
        state.status = .awaitingDeepLink(token)
        return .none

      case .safariDismissed:
        // Only meaningful from awaitingDeepLink. If the deep link
        // already arrived (status == .completed) the Safari dismissal
        // is just cleanup — don't downgrade the terminal state.
        guard case .awaitingDeepLink = state.status else { return .none }
        state.status = .idle
        return .none

      case .deepLinkReceived(let orderId):
        state.status = .completed(orderId: orderId)
        return .send(.delegate(.completed(orderId: orderId)))

      case .retryTapped:
        // Retries are allowed from any non-completed state. Common path
        // is `.failed → requesting` but we also tolerate retry from
        // `.idle` (defensive) and from `.readyToOpen` (user wants a
        // fresh token because the visible one is stale).
        guard !isCompleted(state.status) else { return .none }
        return beginHandoffRequest(state: &state)

      case .dismissTapped:
        return .send(.delegate(.dismissed))

      case .delegate:
        return .none
      }
    }
  }

  private func beginHandoffRequest(state: inout State) -> Effect<Action> {
    state.status = .requesting
    let cartId = state.cartId
    let deliveryAddressId = state.deliveryAddressId
    return .run { [handoffAPIClient] send in
      do {
        let token = try await handoffAPIClient.createCheckoutHandoff(cartId, deliveryAddressId)
        await send(.handoffReceived(.success(token)))
      } catch {
        await send(.handoffReceived(.failure(EquatableError(error))))
      }
    }
  }
}

// MARK: - Helpers

private func isCompleted(_ status: CheckoutHandoffFeature.Status) -> Bool {
  if case .completed = status { return true }
  return false
}
