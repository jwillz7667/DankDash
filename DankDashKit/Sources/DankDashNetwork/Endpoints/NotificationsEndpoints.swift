import Foundation

/// Notifications endpoint catalog. Phase 18 ships the device-token
/// registration endpoint as a server-side stub (204 without persisting);
/// Phase 19 lights up the APNs send pipeline, at which point the
/// implementation switches to a `push_tokens` upsert without changing
/// the wire contract or the iOS call site.
public enum NotificationsEndpoints {
  /// `POST /v1/notifications/register-device`. The iOS client fires
  /// this from `PushNotificationClient` on every
  /// `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`
  /// callback. Stub semantics in this phase: server validates the body
  /// shape and returns 204; nothing is persisted. We still call it so
  /// Phase 19 can flip the server without an iOS release.
  public static func registerDevice(
    body: RegisterDeviceRequestDTO
  ) -> Endpoint<EmptyResponse> {
    Endpoint(
      method: .POST,
      path: "v1/notifications/register-device",
      body: AnyEncodableBody(body),
      requiresAuth: true
    )
  }
}
