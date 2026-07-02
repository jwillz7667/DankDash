import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Closure-backed abstraction over the driver payout bank-account endpoints
/// (`GET/POST /v1/driver/payouts/bank-account[/link]`). ``DriverEarningsFeature``
/// depends on this struct rather than poking ``APIClient`` directly so the
/// TestStore tests substitute typed closures.
///
/// `getStatus` projects the wire boolean straight through. `startLink` takes
/// no argument — the `returnUrl` is an app-config concern bound at the
/// composition root (see `AppEnvironment`), not something the reducer knows —
/// and throws ``DriverAPIError/malformedPayload`` when the session projection
/// fails (bad hosted URL or expiry).
public struct DriverPayoutAccountAPIClient: Sendable {
  public var getStatus: @Sendable () async throws -> Bool
  public var startLink: @Sendable () async throws -> AeropayLinkSession

  public init(
    getStatus: @Sendable @escaping () async throws -> Bool,
    startLink: @Sendable @escaping () async throws -> AeropayLinkSession
  ) {
    self.getStatus = getStatus
    self.startLink = startLink
  }
}

public extension DriverPayoutAccountAPIClient {
  /// Production binding. `returnURL` is the absolute URL Aeropay redirects to
  /// after the hosted bank-link flow completes; injected here so the API
  /// surface stays agnostic about the driver host.
  static func live(apiClient: APIClient, returnURL: URL) -> DriverPayoutAccountAPIClient {
    DriverPayoutAccountAPIClient(
      getStatus: {
        let dto = try await apiClient.send(DriverPayoutAccountEndpoints.bankAccountStatus())
        return dto.linked
      },
      startLink: {
        let body = StartDriverBankLinkRequestDTO(returnUrl: returnURL.absoluteString)
        let dto = try await apiClient.send(DriverPayoutAccountEndpoints.startBankLink(body: body))
        guard let session = dto.link.toDomain() else {
          throw DriverAPIError.malformedPayload("AeropayLinkSession")
        }
        return session
      }
    )
  }

  static let unimplemented = DriverPayoutAccountAPIClient(
    getStatus: { throw DriverAPIError.unimplemented("getStatus") },
    startLink: { throw DriverAPIError.unimplemented("startLink") }
  )
}

private enum DriverPayoutAccountAPIClientKey: DependencyKey {
  static let liveValue: DriverPayoutAccountAPIClient = .unimplemented
  static let testValue: DriverPayoutAccountAPIClient = .unimplemented
}

public extension DependencyValues {
  var driverPayoutAccountAPIClient: DriverPayoutAccountAPIClient {
    get { self[DriverPayoutAccountAPIClientKey.self] }
    set { self[DriverPayoutAccountAPIClientKey.self] = newValue }
  }
}
