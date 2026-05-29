import Foundation
#if canImport(UIKit)
import UIKit
#endif
import DankDashNetwork

/// Drives the APNs registration handshake and forwards every successful
/// device-token update to `POST /v1/notifications/register-device`. Both
/// the consumer and driver `UIApplicationDelegate` shims own one of
/// these — they bootstrap on launch and forward the three APNs
/// callbacks. Nothing else needs to import `UNUserNotificationCenter`
/// or `UIApplication`.
@MainActor
public final class PushTokenRegistrar {
  private let deviceIdKey: String
  private let apiClient: APIClient
  private let pushClient: PushNotificationClient
  private var forwardingTask: Task<Void, Never>?

  public init(
    deviceIdKey: String,
    apiClient: APIClient,
    pushClient: PushNotificationClient = .live
  ) {
    self.deviceIdKey = deviceIdKey
    self.apiClient = apiClient
    self.pushClient = pushClient
  }

  /// Requests authorization, registers with APNs, and starts draining
  /// device-token updates into the server. Idempotent — repeat calls
  /// don't start a second forwarding loop.
  public func bootstrap() {
    if forwardingTask == nil {
      forwardingTask = Task { [weak self] in
        await self?.forwardTokens()
      }
    }
    Task { [pushClient] in
      let granted = await pushClient.requestAuthorization()
      guard granted else { return }
      await pushClient.registerForRemoteNotifications()
    }
  }

  public func didRegister(_ token: Data) {
    pushClient.submitDeviceToken(token)
  }

  public func didFailToRegister(_ error: Error) {
    pushClient.submitRegistrationFailure(error)
  }

  private func forwardTokens() async {
    let deviceId = resolvedDeviceId()
    for await update in pushClient.tokenUpdates() {
      guard case .registered(let data) = update else { continue }
      let hex = data.map { String(format: "%02x", $0) }.joined()
      let body = RegisterDeviceRequestDTO(apnsToken: hex, deviceId: deviceId)
      _ = try? await apiClient.send(NotificationsEndpoints.registerDevice(body: body))
    }
  }

  private func resolvedDeviceId() -> UUID {
    #if canImport(UIKit)
    if let vendorId = UIDevice.current.identifierForVendor {
      return vendorId
    }
    #endif
    let defaults = UserDefaults.standard
    if let raw = defaults.string(forKey: deviceIdKey), let uuid = UUID(uuidString: raw) {
      return uuid
    }
    let generated = UUID()
    defaults.set(generated.uuidString, forKey: deviceIdKey)
    return generated
  }
}
