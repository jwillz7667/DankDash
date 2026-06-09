import Foundation

/// Notification-preferences endpoint catalog — read and partially update the
/// caller's five notification toggles. Both require auth and are self-scoped
/// (the server derives the user from the JWT; there is no `:id` path and so
/// no cross-user surface).
///
/// `GET` synthesizes the all-on defaults for a user who never saved (no row
/// is created on read). `PATCH` upserts the single per-user row and returns
/// the full effective preferences.
public enum NotificationPreferencesEndpoints {
  /// `GET /v1/me/notification-preferences` — the caller's effective toggles.
  public static func getPreferences() -> Endpoint<NotificationPreferencesResponseDTO> {
    Endpoint(
      method: .GET,
      path: "v1/me/notification-preferences",
      requiresAuth: true
    )
  }

  /// `PATCH /v1/me/notification-preferences` — partial update of any subset
  /// of the toggles. An empty body is a 422 server-side, so callers must
  /// send at least one toggle.
  public static func updatePreferences(
    body: UpdateNotificationPreferencesRequestDTO
  ) -> Endpoint<NotificationPreferencesResponseDTO> {
    Endpoint(
      method: .PATCH,
      path: "v1/me/notification-preferences",
      body: AnyEncodableBody(body),
      requiresAuth: true
    )
  }
}
