import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Two-step password reset against the backend reset surface:
///
///   1. `.request` — the user enters their account email; `submitTapped`
///      calls `POST /v1/auth/forgot-password`. The server always answers 202
///      (enumeration-safe), so on any success we advance to `.redeem` and ask
///      the user to check their email for a code. We never confirm or deny
///      that the address is registered.
///   2. `.redeem` — the user enters the emailed code plus a new password;
///      `resetTapped` calls `POST /v1/auth/reset-password`. A 204 advances to
///      `.done`. The server is authoritative on code validity/expiry and its
///      message surfaces verbatim on failure (e.g. an expired or used code).
///   3. `.done` — terminal success; the only action is to return to sign-in.
///
/// The client mirrors the server's password policy (≥12 chars, ≥1 letter &
/// ≥1 digit) and the 12-symbol code length for the submit-button gate only —
/// the server re-validates and normalizes confusable glyphs/case itself.
@Reducer
public struct ForgotPasswordFeature: Sendable {
  public enum Step: Equatable, Sendable {
    case request
    case redeem
    case done
  }

  @ObservableState
  public struct State: Equatable, Sendable {
    public var step: Step
    public var email: String
    public var code: String
    public var newPassword: String
    public var isSubmitting: Bool
    public var error: String?

    public init(
      step: Step = .request,
      email: String = "",
      code: String = "",
      newPassword: String = "",
      isSubmitting: Bool = false,
      error: String? = nil
    ) {
      self.step = step
      self.email = email
      self.code = code
      self.newPassword = newPassword
      self.isSubmitting = isSubmitting
      self.error = error
    }

    public var emailIsValid: Bool { Email(email) != nil }
    public var canRequest: Bool { !isSubmitting && step == .request && emailIsValid }

    /// The display code is 12 Crockford symbols (`XXXX-XXXX-XXXX`). We gate on
    /// 12 significant characters once separators/whitespace are stripped; the
    /// server folds confusable glyphs and is authoritative on the actual value.
    public var codeIsValid: Bool {
      code.filter { !$0.isWhitespace && $0 != "-" }.count >= 12
    }
    public var passwordMeetsPolicy: Bool {
      newPassword.count >= 12
        && newPassword.contains(where: \.isLetter)
        && newPassword.contains(where: \.isNumber)
    }
    public var canRedeem: Bool {
      !isSubmitting && step == .redeem && codeIsValid && passwordMeetsPolicy
    }
  }

  public enum Action: Equatable, Sendable {
    case emailChanged(String)
    case codeChanged(String)
    case newPasswordChanged(String)
    case submitTapped
    case resetTapped
    case requestResponse(Result<EmptyResponse, APIErrorBox>)
    case resetResponse(Result<EmptyResponse, APIErrorBox>)
    case dismissTapped
    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Equatable, Sendable {
      case dismissed
    }
  }

  @Dependency(\.authAPIClient) var auth

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .emailChanged(let value):
        state.email = value
        state.error = nil
        return .none

      case .codeChanged(let value):
        state.code = value
        state.error = nil
        return .none

      case .newPasswordChanged(let value):
        state.newPassword = value
        state.error = nil
        return .none

      case .submitTapped:
        guard state.canRequest else { return .none }
        state.isSubmitting = true
        state.error = nil
        let request = ForgotPasswordRequestDTO(email: state.email.lowercased())
        return .run { send in
          do {
            let response = try await auth.forgotPassword(request)
            await send(.requestResponse(.success(response)))
          } catch {
            await send(.requestResponse(.failure(APIErrorBox(error))))
          }
        }

      case .requestResponse(.success):
        state.isSubmitting = false
        state.step = .redeem
        return .none

      case .requestResponse(.failure(let box)):
        state.isSubmitting = false
        state.error = box.userFacingMessage(
          default: "We couldn't start your reset. Try again."
        )
        return .none

      case .resetTapped:
        guard state.canRedeem else { return .none }
        state.isSubmitting = true
        state.error = nil
        let request = ResetPasswordRequestDTO(code: state.code, newPassword: state.newPassword)
        return .run { send in
          do {
            let response = try await auth.resetPassword(request)
            await send(.resetResponse(.success(response)))
          } catch {
            await send(.resetResponse(.failure(APIErrorBox(error))))
          }
        }

      case .resetResponse(.success):
        state.isSubmitting = false
        state.step = .done
        // The plaintext credential no longer needs to live in memory.
        state.code = ""
        state.newPassword = ""
        return .none

      case .resetResponse(.failure(let box)):
        state.isSubmitting = false
        state.error = box.userFacingMessage(
          default: "We couldn't reset your password. Check your code and try again."
        )
        return .none

      case .dismissTapped:
        return .send(.delegate(.dismissed))

      case .delegate:
        return .none
      }
    }
  }
}
