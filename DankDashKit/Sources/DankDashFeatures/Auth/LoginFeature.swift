import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Email + password login. The three response branches the backend
/// produces (authenticated, mfa_required, server error) map onto three
/// reducer transitions: post the tokens via delegate, push the MFA
/// prompt, or surface the server message.
@Reducer
public struct LoginFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable {
    public var email: String
    public var password: String
    public var mfaChallengeId: String?
    public var mfaCode: String
    public var mfaError: String?
    public var isSubmitting: Bool
    public var error: String?

    public init(
      email: String = "",
      password: String = "",
      mfaChallengeId: String? = nil,
      mfaCode: String = "",
      mfaError: String? = nil,
      isSubmitting: Bool = false,
      error: String? = nil
    ) {
      self.email = email
      self.password = password
      self.mfaChallengeId = mfaChallengeId
      self.mfaCode = mfaCode
      self.mfaError = mfaError
      self.isSubmitting = isSubmitting
      self.error = error
    }

    public var emailIsValid: Bool { Email(email) != nil }
    public var passwordIsValid: Bool { !password.isEmpty }
    public var canSubmit: Bool { !isSubmitting && emailIsValid && passwordIsValid }
    public var mfaCodeIsValid: Bool {
      mfaCode.count == 6 && mfaCode.allSatisfy(\.isNumber)
    }
    public var canSubmitMfa: Bool {
      !isSubmitting && mfaChallengeId != nil && mfaCodeIsValid
    }
  }

  public enum Action: Equatable, Sendable {
    case emailChanged(String)
    case passwordChanged(String)
    case mfaCodeChanged(String)
    case loginTapped
    case mfaVerifyTapped
    case loginResponse(Result<LoginResponseDTO, APIErrorBox>)
    case mfaResponse(Result<MfaVerifyResponseDTO, APIErrorBox>)
    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Equatable, Sendable {
      case authenticated(user: UserSummaryDTO, tokens: TokenPairDTO)
    }
  }

  @Dependency(\.authAPIClient) var auth
  @Dependency(\.tokenStore) var tokens

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .emailChanged(let value):
        state.email = value
        state.error = nil
        return .none

      case .passwordChanged(let value):
        state.password = value
        state.error = nil
        return .none

      case .mfaCodeChanged(let value):
        state.mfaCode = value.filter(\.isNumber)
        state.mfaError = nil
        return .none

      case .loginTapped:
        guard state.canSubmit else { return .none }
        state.isSubmitting = true
        state.error = nil
        let request = LoginRequestDTO(email: state.email.lowercased(), password: state.password)
        return .run { send in
          do {
            let response = try await auth.login(request)
            await send(.loginResponse(.success(response)))
          } catch {
            await send(.loginResponse(.failure(APIErrorBox(error))))
          }
        }

      case .mfaVerifyTapped:
        guard let challengeId = state.mfaChallengeId, state.canSubmitMfa else { return .none }
        state.isSubmitting = true
        state.mfaError = nil
        let request = MfaVerifyRequestDTO(challengeId: challengeId, code: state.mfaCode)
        return .run { send in
          do {
            let response = try await auth.verifyMfa(request)
            await send(.mfaResponse(.success(response)))
          } catch {
            await send(.mfaResponse(.failure(APIErrorBox(error))))
          }
        }

      case .loginResponse(.success(let response)):
        state.isSubmitting = false
        switch response {
        case let .authenticated(user, tokenPair):
          return .run { send in
            await tokens.persist(tokenPair)
            await send(.delegate(.authenticated(user: user, tokens: tokenPair)))
          }
        case let .mfaRequired(challengeId, _):
          state.mfaChallengeId = challengeId
          state.mfaCode = ""
          return .none
        }

      case .loginResponse(.failure(let box)):
        state.isSubmitting = false
        state.error = box.userFacingMessage(default: "We couldn't sign you in. Try again.")
        return .none

      case .mfaResponse(.success(let response)):
        state.isSubmitting = false
        let tokenPair = response.tokens
        let user = response.user
        return .run { send in
          await tokens.persist(tokenPair)
          await send(.delegate(.authenticated(user: user, tokens: tokenPair)))
        }

      case .mfaResponse(.failure(let box)):
        state.isSubmitting = false
        state.mfaError = box.userFacingMessage(default: "That code didn't work. Try again.")
        return .none

      case .delegate:
        return .none
      }
    }
  }
}

/// Wraps APIError into something Equatable so TestStore can carry it
/// through actions. We collapse the cases into ones the UI cares about.
public struct APIErrorBox: Error, Equatable, Sendable {
  public enum Kind: Equatable, Sendable {
    case unauthorized
    case server(code: String, message: String)
    case transport
    case decoding
    case other
  }

  public let kind: Kind

  public init(_ error: Error) {
    if let apiError = error as? APIError {
      switch apiError {
      case .unauthorized: self.kind = .unauthorized
      case .noRefreshToken: self.kind = .unauthorized
      case .server(_, let envelope): self.kind = .server(code: envelope.error.code, message: envelope.error.message)
      case .unexpectedStatus: self.kind = .other
      case .transport: self.kind = .transport
      case .decoding: self.kind = .decoding
      case .configuration: self.kind = .other
      }
    } else {
      self.kind = .other
    }
  }

  /// Returns a UX-friendly message; the server's message wins when we
  /// have one, otherwise we fall back to the caller's default.
  public func userFacingMessage(default fallback: String) -> String {
    switch kind {
    case .server(_, let message): message
    case .unauthorized: "Email or password is incorrect."
    case .transport: "We couldn't reach DankDash. Check your connection."
    case .decoding, .other: fallback
    }
  }
}
