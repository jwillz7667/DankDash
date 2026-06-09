import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Notification-preferences manager reached from the Account tab. Loads the
/// caller's five toggles and lets them flip each one independently.
///
/// Each switch is **optimistic**: the flip is applied to local state
/// immediately and the toggle is added to `savingToggles`, then a
/// single-key PATCH is sent. On success the full server row is adopted
/// wholesale (the server is authoritative and returns every toggle plus a
/// fresh `updatedAt`); on failure the toggle is reverted to its
/// pre-flip value and an error surfaces. `savingToggles` disables the
/// individual switch while its PATCH is in flight so a rapid double-flip
/// can't race two writes for the same toggle.
@Reducer
public struct NotificationPreferencesFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable {
    /// `nil` until the first load resolves; the view shows a loading row.
    public var preferences: NotificationPreferences?
    public var isLoading: Bool
    public var error: String?
    /// Toggles with an in-flight PATCH — each is disabled in the view.
    public var savingToggles: Set<NotificationToggle>

    public init(
      preferences: NotificationPreferences? = nil,
      isLoading: Bool = false,
      error: String? = nil,
      savingToggles: Set<NotificationToggle> = []
    ) {
      self.preferences = preferences
      self.isLoading = isLoading
      self.error = error
      self.savingToggles = savingToggles
    }
  }

  public enum Action: Sendable, Equatable {
    case onAppear
    case refreshTapped
    case preferencesLoaded(Result<NotificationPreferences, EquatableError>)

    case toggleChanged(NotificationToggle, Bool)
    case toggleResponse(
      NotificationToggle,
      previous: Bool,
      Result<NotificationPreferences, EquatableError>
    )
  }

  @Dependency(\.notificationPreferencesAPIClient) var notificationPreferencesAPIClient

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .onAppear:
        // First entry only — a re-appear keeps whatever the last load /
        // toggle produced.
        guard !state.isLoading, state.preferences == nil else { return .none }
        state.isLoading = true
        return reload()

      case .refreshTapped:
        state.error = nil
        return reload()

      case .preferencesLoaded(.success(let preferences)):
        state.isLoading = false
        state.preferences = preferences
        return .none

      case .preferencesLoaded(.failure(let error)):
        state.isLoading = false
        state.error = error.message
        return .none

      case .toggleChanged(let toggle, let newValue):
        // Need a baseline to flip and to revert to on failure. Ignore a flip
        // that arrives before the first load resolves, or a re-flip of a
        // toggle whose PATCH is still in flight.
        guard let current = state.preferences,
              !state.savingToggles.contains(toggle) else { return .none }
        let previous = current.value(for: toggle)
        guard previous != newValue else { return .none }
        state.preferences = current.setting(toggle, to: newValue)
        state.savingToggles.insert(toggle)
        state.error = nil
        return .run { [notificationPreferencesAPIClient] send in
          do {
            let updated = try await notificationPreferencesAPIClient.updatePreferences(
              .single(toggle, to: newValue)
            )
            await send(.toggleResponse(toggle, previous: previous, .success(updated)))
          } catch {
            await send(
              .toggleResponse(toggle, previous: previous, .failure(EquatableError(error)))
            )
          }
        }

      case .toggleResponse(let toggle, _, .success(let updated)):
        state.savingToggles.remove(toggle)
        // Adopt the authoritative server row wholesale — it carries every
        // toggle plus the refreshed `updatedAt`.
        state.preferences = updated
        return .none

      case .toggleResponse(let toggle, let previous, .failure(let error)):
        state.savingToggles.remove(toggle)
        // Revert just this toggle to its pre-flip value, leaving any other
        // toggles the user changed meanwhile untouched.
        if let current = state.preferences {
          state.preferences = current.setting(toggle, to: previous)
        }
        state.error = error.message
        return .none
      }
    }
  }

  private func reload() -> Effect<Action> {
    .run { [notificationPreferencesAPIClient] send in
      do {
        let preferences = try await notificationPreferencesAPIClient.getPreferences()
        await send(.preferencesLoaded(.success(preferences)))
      } catch {
        await send(.preferencesLoaded(.failure(EquatableError(error))))
      }
    }
  }
}
