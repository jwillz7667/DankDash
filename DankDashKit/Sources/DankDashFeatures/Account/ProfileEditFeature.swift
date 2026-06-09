import Foundation
import ComposableArchitecture
import DankDashNetwork

/// Edit-profile form. The backend's `PATCH /v1/me` only accepts first and
/// last name (email / phone / DOB are step-up-gated and live elsewhere),
/// so this surface is deliberately just those two fields plus a read-only
/// email line for context. On success it emits `delegate(.saved)` carrying
/// the refreshed user so the parent can update its identity and pop.
@Reducer
public struct ProfileEditFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable {
    public var firstName: String
    public var lastName: String
    public let email: String
    public var isSubmitting: Bool
    public var error: String?

    public init(
      firstName: String = "",
      lastName: String = "",
      email: String = "",
      isSubmitting: Bool = false,
      error: String? = nil
    ) {
      self.firstName = firstName
      self.lastName = lastName
      self.email = email
      self.isSubmitting = isSubmitting
      self.error = error
    }

    /// Mirrors the server constraint (`z.string().trim().min(1).max(80)`)
    /// so the UX preview matches what the authoritative validator accepts.
    public var firstNameIsValid: Bool { Self.isValidName(firstName) }
    public var lastNameIsValid: Bool { Self.isValidName(lastName) }

    public var canSave: Bool {
      !isSubmitting && firstNameIsValid && lastNameIsValid
    }

    private static func isValidName(_ value: String) -> Bool {
      let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
      return !trimmed.isEmpty && trimmed.count <= 80
    }
  }

  public enum Action: Equatable, Sendable {
    case firstNameChanged(String)
    case lastNameChanged(String)
    case saveTapped
    case cancelTapped
    case saveResponse(Result<UserSummaryDTO, APIErrorBox>)
    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Equatable, Sendable {
      case saved(UserSummaryDTO)
      case cancelled
    }
  }

  @Dependency(\.meAPIClient) var meAPIClient

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .firstNameChanged(let value):
        state.firstName = value
        state.error = nil
        return .none

      case .lastNameChanged(let value):
        state.lastName = value
        state.error = nil
        return .none

      case .saveTapped:
        guard state.canSave else { return .none }
        state.isSubmitting = true
        state.error = nil
        let body = UpdateMeRequestDTO(
          firstName: state.firstName.trimmingCharacters(in: .whitespacesAndNewlines),
          lastName: state.lastName.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        return .run { [meAPIClient] send in
          do {
            let user = try await meAPIClient.updateProfile(body)
            await send(.saveResponse(.success(user)))
          } catch {
            await send(.saveResponse(.failure(APIErrorBox(error))))
          }
        }

      case .saveResponse(.success(let user)):
        state.isSubmitting = false
        return .send(.delegate(.saved(user)))

      case .saveResponse(.failure(let box)):
        state.isSubmitting = false
        state.error = box.userFacingMessage(default: "We couldn't save your profile. Try again.")
        return .none

      case .cancelTapped:
        return .send(.delegate(.cancelled))

      case .delegate:
        return .none
      }
    }
  }
}
