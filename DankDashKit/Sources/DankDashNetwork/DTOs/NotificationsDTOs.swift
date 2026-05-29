import Foundation

/// Body for `POST /v1/notifications/register-device`. Phase 18 stubs
/// the endpoint server-side (returns 204 without persisting); the iOS
/// client sends the same shape so Phase 19 — which lights up the APNs
/// send pipeline — can switch the implementation from no-op to
/// `push_tokens` upsert without renegotiating the wire contract.
///
/// `apnsToken` is the lowercase-hex 64-char Apple-issued device token
/// (32 raw bytes → 64 hex chars via `Data.map { String(format: "%02x", $0) }`).
/// `deviceId` is `UIDevice.identifierForVendor` UUID — stable across
/// reinstalls of the same vendor's apps. `platform` is "ios" only for
/// this phase; the field is left in for a future Android client.
public struct RegisterDeviceRequestDTO: Encodable, Sendable, Equatable {
  public let apnsToken: String
  public let deviceId: String
  public let platform: String

  public init(apnsToken: String, deviceId: UUID, platform: String = "ios") {
    self.apnsToken = apnsToken
    self.deviceId = deviceId.uuidString.lowercased()
    self.platform = platform
  }
}
