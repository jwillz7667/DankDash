import Foundation
import ComposableArchitecture
import DankDashDomain

/// Hard gate enforced before any other surface renders. Per Minn. Stat.
/// §342.27 the consumer app may not allow cannabis content to anyone
/// under 21; the gate keeps under-21 users out of the catalog/checkout
/// paths entirely. KYC age verification (Phase 17) is the authoritative
/// check — this is the client-side first-line UX guard.
@Reducer
public struct AgeGateFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable {
    public var month: Int
    public var day: Int
    public var year: Int
    public var acknowledged: Bool
    public var error: String?

    public init(
      month: Int = 1,
      day: Int = 1,
      year: Int = Calendar(identifier: .gregorian).component(.year, from: Date()) - 30,
      acknowledged: Bool = false,
      error: String? = nil
    ) {
      self.month = month
      self.day = day
      self.year = year
      self.acknowledged = acknowledged
      self.error = error
    }

    /// Whether the form is currently submittable.
    public var canSubmit: Bool {
      acknowledged && resolvedDOB() != nil
    }

    func resolvedDOB() -> DateOfBirth? {
      DateOfBirth(year: year, month: month, day: day)
    }
  }

  public enum Action: Equatable, Sendable {
    case monthChanged(Int)
    case dayChanged(Int)
    case yearChanged(Int)
    case acknowledgementToggled(Bool)
    case submitTapped
    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Equatable, Sendable {
      case passed
    }
  }

  @Dependency(\.date) var now

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .monthChanged(let value):
        state.month = value
        state.error = nil
        return .none

      case .dayChanged(let value):
        state.day = value
        state.error = nil
        return .none

      case .yearChanged(let value):
        state.year = value
        state.error = nil
        return .none

      case .acknowledgementToggled(let value):
        state.acknowledged = value
        return .none

      case .submitTapped:
        guard let dob = state.resolvedDOB() else {
          state.error = "Enter a valid date of birth."
          return .none
        }
        if dob.isOver21(asOf: now.now) {
          return .send(.delegate(.passed))
        }
        state.error = "You must be 21 or older to use DankDash."
        return .none

      case .delegate:
        return .none
      }
    }
  }
}
