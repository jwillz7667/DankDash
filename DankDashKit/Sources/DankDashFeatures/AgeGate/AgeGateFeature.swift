import Foundation
import ComposableArchitecture

/// Hard gate enforced before any other surface renders. Per Minn. Stat.
/// §342.27 the consumer app may not expose cannabis content to anyone
/// under 21, so this gate keeps under-21 users out of the catalog and
/// checkout paths entirely.
///
/// This is the client-side first-line UX guard, not an identity check. We
/// deliberately collect no date of birth here: a self-attested DOB adds
/// no assurance over a single "I am 21 or older" affirmation, and the
/// authoritative age controls live elsewhere — KYC age verification
/// (Phase 17) re-derives age from a verified ID document, and the driver
/// scans a government-issued ID at handoff (which the gate copy promises).
@Reducer
public struct AgeGateFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable {
    /// Set when the customer declines the 21+ attestation. Cleared on the
    /// next affirmative tap so a mis-tap doesn't strand the customer.
    public var error: String?

    public init(error: String? = nil) {
      self.error = error
    }
  }

  public enum Action: Equatable, Sendable {
    /// "I am 21 or older" — the customer attests to age and to the
    /// at-delivery ID requirement; the gate opens.
    case confirmTapped
    /// "I am under 21" — surfaces the block message; the gate stays shut.
    case declineTapped
    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Equatable, Sendable {
      case passed
    }
  }

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .confirmTapped:
        state.error = nil
        return .send(.delegate(.passed))

      case .declineTapped:
        state.error = "You must be 21 or older to use DankDash."
        return .none

      case .delegate:
        return .none
      }
    }
  }
}
