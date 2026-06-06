import Foundation

/// Notifications endpoint catalog. Registers an APNs device token for the
/// calling user so the backend's notification dispatcher can fan order /
/// dispatch pushes to the right device + app variant.
public enum NotificationsEndpoints {
  /// `POST /v1/me/push-tokens`. The iOS client fires this from
  /// `PushTokenRegistrar` on every
  /// `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`
  /// callback. The server upserts the token keyed by
  /// `(user_id, device_id, app_variant)` and returns 201 with the stored
  /// row; the client treats the result as fire-and-forget.
  public static func registerDevice(
    body: RegisterDeviceRequestDTO
  ) -> Endpoint<EmptyResponse> {
    Endpoint(
      method: .POST,
      path: "v1/me/push-tokens",
      body: AnyEncodableBody(body),
      requiresAuth: true
    )
  }
}
