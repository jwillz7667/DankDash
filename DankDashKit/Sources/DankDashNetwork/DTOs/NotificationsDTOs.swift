import Foundation

/// Which DankDash app a push token belongs to. The backend fans
/// `dispatch.offer` only to `.driver` tokens and consumer order-status
/// notifications only to `.consumer` tokens, so the variant is part of
/// the unique key `(user_id, device_id, app_variant)` on `push_tokens`.
public enum PushAppVariant: String, Sendable, Equatable {
  case consumer
  case driver
}

/// Body for `POST /v1/me/push-tokens`. The iOS client fires this from
/// `PushTokenRegistrar` on every
/// `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`
/// callback; the server upserts the row keyed by
/// `(user_id, device_id, app_variant)`, rotating the APNs token in place.
///
/// `apnsToken` is the lowercase-hex 64-char Apple-issued device token
/// (32 raw bytes → 64 hex chars via `Data.map { String(format: "%02x", $0) }`).
/// `deviceId` is `UIDevice.identifierForVendor` UUID — stable across
/// reinstalls of the same vendor's apps. `platform` is "ios" only for
/// now; the field is left in for a future Android client. `appVariant`
/// distinguishes the consumer app from the driver app.
public struct RegisterDeviceRequestDTO: Encodable, Sendable, Equatable {
  public let apnsToken: String
  public let deviceId: String
  public let platform: String
  public let appVariant: String

  public init(
    apnsToken: String,
    deviceId: UUID,
    appVariant: PushAppVariant,
    platform: String = "ios"
  ) {
    self.apnsToken = apnsToken
    self.deviceId = deviceId.uuidString.lowercased()
    self.appVariant = appVariant.rawValue
    self.platform = platform
  }
}
