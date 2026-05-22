import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Register flow. Mirrors the backend's structural validation rules
/// (apps/api/.../auth/dto/register.dto.ts) so the client doesn't post
/// payloads that we already know the server will reject — the server
/// remains authoritative, the client just stops obvious typos.
@Reducer
public struct SignUpFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable {
    public var firstName: String
    public var lastName: String
    public var email: String
    public var phone: String
    public var password: String
    public var dateOfBirth: DateOfBirth?
    public var isSubmitting: Bool
    public var error: String?
    public var fieldErrors: FieldErrors

    public struct FieldErrors: Equatable, Sendable {
      public var firstName: String?
      public var lastName: String?
      public var email: String?
      public var phone: String?
      public var password: String?
      public var dateOfBirth: String?

      public init(
        firstName: String? = nil,
        lastName: String? = nil,
        email: String? = nil,
        phone: String? = nil,
        password: String? = nil,
        dateOfBirth: String? = nil
      ) {
        self.firstName = firstName
        self.lastName = lastName
        self.email = email
        self.phone = phone
        self.password = password
        self.dateOfBirth = dateOfBirth
      }

      public var isClean: Bool {
        firstName == nil && lastName == nil && email == nil
          && phone == nil && password == nil && dateOfBirth == nil
      }
    }

    public init(
      firstName: String = "",
      lastName: String = "",
      email: String = "",
      phone: String = "",
      password: String = "",
      dateOfBirth: DateOfBirth? = nil,
      isSubmitting: Bool = false,
      error: String? = nil,
      fieldErrors: FieldErrors = .init()
    ) {
      self.firstName = firstName
      self.lastName = lastName
      self.email = email
      self.phone = phone
      self.password = password
      self.dateOfBirth = dateOfBirth
      self.isSubmitting = isSubmitting
      self.error = error
      self.fieldErrors = fieldErrors
    }

    public var passwordIsValid: Bool {
      SignUpFeature.passwordSatisfiesPolicy(password)
    }

    public var emailIsValid: Bool { Email(email) != nil }
    public var firstNameIsValid: Bool {
      let trimmed = firstName.trimmingCharacters(in: .whitespaces)
      return !trimmed.isEmpty && trimmed.count <= 80
    }
    public var lastNameIsValid: Bool {
      let trimmed = lastName.trimmingCharacters(in: .whitespaces)
      return !trimmed.isEmpty && trimmed.count <= 80
    }
    public var phoneIsValid: Bool {
      let trimmed = phone.trimmingCharacters(in: .whitespaces)
      return trimmed.isEmpty || Phone(trimmed) != nil
    }

    public var canSubmit: Bool {
      !isSubmitting
        && firstNameIsValid
        && lastNameIsValid
        && emailIsValid
        && phoneIsValid
        && passwordIsValid
        && dateOfBirth != nil
    }
  }

  public enum Action: Equatable, Sendable {
    case firstNameChanged(String)
    case lastNameChanged(String)
    case emailChanged(String)
    case phoneChanged(String)
    case passwordChanged(String)
    case dateOfBirthChanged(DateOfBirth?)
    case submitTapped
    case registerResponse(Result<RegisterResponseDTO, APIErrorBox>)
    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Equatable, Sendable {
      case registered(user: UserSummaryDTO, tokens: TokenPairDTO)
    }
  }

  @Dependency(\.authAPIClient) var auth
  @Dependency(\.tokenStore) var tokens

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .firstNameChanged(let value):
        state.firstName = value
        state.fieldErrors.firstName = nil
        state.error = nil
        return .none

      case .lastNameChanged(let value):
        state.lastName = value
        state.fieldErrors.lastName = nil
        state.error = nil
        return .none

      case .emailChanged(let value):
        state.email = value
        state.fieldErrors.email = nil
        state.error = nil
        return .none

      case .phoneChanged(let value):
        state.phone = value
        state.fieldErrors.phone = nil
        state.error = nil
        return .none

      case .passwordChanged(let value):
        state.password = value
        state.fieldErrors.password = nil
        state.error = nil
        return .none

      case .dateOfBirthChanged(let value):
        state.dateOfBirth = value
        state.fieldErrors.dateOfBirth = nil
        state.error = nil
        return .none

      case .submitTapped:
        let validated = Self.validate(state)
        guard validated.fieldErrors.isClean, !state.isSubmitting else {
          state.fieldErrors = validated.fieldErrors
          return .none
        }
        state.isSubmitting = true
        state.error = nil
        state.fieldErrors = .init()
        let request = validated.request!
        return .run { send in
          do {
            let response = try await auth.register(request)
            await send(.registerResponse(.success(response)))
          } catch {
            await send(.registerResponse(.failure(APIErrorBox(error))))
          }
        }

      case .registerResponse(.success(let response)):
        state.isSubmitting = false
        let tokenPair = response.tokens
        let user = response.user
        return .run { send in
          await tokens.persist(tokenPair)
          await send(.delegate(.registered(user: user, tokens: tokenPair)))
        }

      case .registerResponse(.failure(let box)):
        state.isSubmitting = false
        state.error = box.userFacingMessage(default: "We couldn't create your account. Try again.")
        return .none

      case .delegate:
        return .none
      }
    }
  }

  /// Backend rule: ≥12 chars, contains at least one letter and one digit.
  /// Restated client-side so we don't post payloads we know will bounce.
  static func passwordSatisfiesPolicy(_ password: String) -> Bool {
    guard password.count >= 12, password.count <= 256 else { return false }
    let hasLetter = password.contains(where: \.isLetter)
    let hasDigit = password.contains(where: \.isNumber)
    return hasLetter && hasDigit
  }

  /// Returns the per-field errors and (when clean) the request DTO.
  private static func validate(_ state: State) -> (fieldErrors: State.FieldErrors, request: RegisterRequestDTO?) {
    var errors = State.FieldErrors()

    let firstName = state.firstName.trimmingCharacters(in: .whitespaces)
    if firstName.isEmpty { errors.firstName = "Enter your first name." }
    else if firstName.count > 80 { errors.firstName = "First name must be 80 characters or fewer." }

    let lastName = state.lastName.trimmingCharacters(in: .whitespaces)
    if lastName.isEmpty { errors.lastName = "Enter your last name." }
    else if lastName.count > 80 { errors.lastName = "Last name must be 80 characters or fewer." }

    let trimmedEmail = state.email.trimmingCharacters(in: .whitespaces).lowercased()
    let email = Email(trimmedEmail)
    if email == nil { errors.email = "Enter a valid email address." }

    let trimmedPhone = state.phone.trimmingCharacters(in: .whitespaces)
    var phoneDTO: Phone?
    if !trimmedPhone.isEmpty {
      phoneDTO = Phone(trimmedPhone)
      if phoneDTO == nil { errors.phone = "Phone must be in E.164 format (e.g. +14155551234)." }
    }

    if !passwordSatisfiesPolicy(state.password) {
      errors.password = "Password must be 12+ characters and include a letter and a digit."
    }

    if state.dateOfBirth == nil { errors.dateOfBirth = "Enter your date of birth." }

    guard errors.isClean,
          let email,
          let dob = state.dateOfBirth
    else {
      return (errors, nil)
    }

    let request = RegisterRequestDTO(
      email: email.rawValue,
      password: state.password,
      phone: phoneDTO?.rawValue,
      dateOfBirth: dob.iso8601,
      firstName: firstName,
      lastName: lastName
    )
    return (errors, request)
  }
}
