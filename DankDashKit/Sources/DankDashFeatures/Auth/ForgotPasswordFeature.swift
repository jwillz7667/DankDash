import Foundation
import ComposableArchitecture
import DankDashDomain

/// Forgot-password flow. The backend reset endpoint isn't part of the
/// Phase 16 verified contract (it lands with the full account-management
/// surface in Phase 17). The reducer is wired with the form validation
/// and submission UX so the view layer can ship today; on submit it
/// surfaces a generic "check your email" confirmation without making a
/// network call, deferring the actual request to a follow-up phase.
@Reducer
public struct ForgotPasswordFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable {
    public var email: String
    public var isSubmitting: Bool
    public var submitted: Bool
    public var error: String?

    public init(
      email: String = "",
      isSubmitting: Bool = false,
      submitted: Bool = false,
      error: String? = nil
    ) {
      self.email = email
      self.isSubmitting = isSubmitting
      self.submitted = submitted
      self.error = error
    }

    public var emailIsValid: Bool { Email(email) != nil }
    public var canSubmit: Bool { !isSubmitting && !submitted && emailIsValid }
  }

  public enum Action: Equatable, Sendable {
    case emailChanged(String)
    case submitTapped
    case dismissTapped
    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Equatable, Sendable {
      case dismissed
    }
  }

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .emailChanged(let value):
        state.email = value
        state.error = nil
        return .none

      case .submitTapped:
        guard state.canSubmit else { return .none }
        // Phase 17 will wire the real /v1/auth/reset-password endpoint;
        // until then the UX confirms-by-default to avoid leaking which
        // emails exist in the system (standard password-reset hygiene).
        state.submitted = true
        return .none

      case .dismissTapped:
        return .send(.delegate(.dismissed))

      case .delegate:
        return .none
      }
    }
  }
}
