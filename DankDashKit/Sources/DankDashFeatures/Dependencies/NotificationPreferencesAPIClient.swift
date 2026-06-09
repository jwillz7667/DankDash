import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Closure-backed abstraction over the notification-preferences endpoints
/// (`GET`/`PATCH /v1/me/notification-preferences`). Reducers depend on this
/// struct rather than `APIClient` so TestStore tests substitute typed
/// closures.
///
/// Both calls return the full effective ``NotificationPreferences`` — the
/// server is authoritative, so even a single-toggle PATCH yields the
/// complete row, which the feature adopts wholesale (keeping `updatedAt`
/// fresh) rather than reconciling locally.
public struct NotificationPreferencesAPIClient: Sendable {
  public var getPreferences: @Sendable () async throws -> NotificationPreferences
  public var updatePreferences: @Sendable (NotificationPreferencesUpdate) async throws ->
    NotificationPreferences

  public init(
    getPreferences: @Sendable @escaping () async throws -> NotificationPreferences,
    updatePreferences: @Sendable @escaping (NotificationPreferencesUpdate) async throws ->
      NotificationPreferences
  ) {
    self.getPreferences = getPreferences
    self.updatePreferences = updatePreferences
  }
}

public extension NotificationPreferencesAPIClient {
  /// Production binding over the shared ``APIClient``.
  static func live(apiClient: APIClient) -> NotificationPreferencesAPIClient {
    NotificationPreferencesAPIClient(
      getPreferences: {
        let dto = try await apiClient.send(NotificationPreferencesEndpoints.getPreferences())
        return dto.toDomain()
      },
      updatePreferences: { update in
        let dto = try await apiClient.send(
          NotificationPreferencesEndpoints.updatePreferences(
            body: UpdateNotificationPreferencesRequestDTO(update)
          )
        )
        return dto.toDomain()
      }
    )
  }

  /// Test fixture that always throws.
  static let unimplemented = NotificationPreferencesAPIClient(
    getPreferences: { throw NotificationPreferencesAPIError.unimplemented("getPreferences") },
    updatePreferences: { _ in
      throw NotificationPreferencesAPIError.unimplemented("updatePreferences")
    }
  )
}

public enum NotificationPreferencesAPIError: Error, Sendable, Equatable {
  case unimplemented(String)
}

private enum NotificationPreferencesAPIClientKey: DependencyKey {
  static let liveValue: NotificationPreferencesAPIClient = .unimplemented
  static let testValue: NotificationPreferencesAPIClient = .unimplemented
}

public extension DependencyValues {
  var notificationPreferencesAPIClient: NotificationPreferencesAPIClient {
    get { self[NotificationPreferencesAPIClientKey.self] }
    set { self[NotificationPreferencesAPIClientKey.self] = newValue }
  }
}
