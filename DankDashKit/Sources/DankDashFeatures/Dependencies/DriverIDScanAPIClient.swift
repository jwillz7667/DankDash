import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// HTTP-only client for the driver ID-scan endpoints. Sits alongside
/// ``DriverOrdersAPIClient`` rather than folded into it because the two
/// surfaces have very different concerns: orders deals with the
/// pickup/delivery transitions, ID-scan brokers a single Veriff session
/// + its terminal result. The reducer (``IDScanFeature``) wires both
/// dependencies independently.
///
///   - **startSession** — POST /v1/driver/orders/:id/id-scan-session
///     returns the Veriff session payload (token + url + verificationId).
///     A malformed `sessionUrl` short-circuits to `malformedPayload`.
///   - **submitResult** — POST /v1/driver/orders/:id/id-scan-result
///     with the verificationId from the SDK. The backend chains the
///     authoritative decision fetch + write and returns the freshly-
///     hydrated `DriverOrderDetailResponse` so the reducer doesn't need
///     a follow-up GET.
public struct DriverIDScanAPIClient: Sendable {
  public var startSession: @Sendable (UUID) async throws -> IDScanSession
  public var submitResult: @Sendable (UUID, String) async throws -> ActiveRoute

  public init(
    startSession: @Sendable @escaping (UUID) async throws -> IDScanSession,
    submitResult: @Sendable @escaping (UUID, String) async throws -> ActiveRoute
  ) {
    self.startSession = startSession
    self.submitResult = submitResult
  }
}

public extension DriverIDScanAPIClient {
  static func live(apiClient: APIClient) -> DriverIDScanAPIClient {
    DriverIDScanAPIClient(
      startSession: { orderId in
        let dto = try await apiClient.send(DriverIDScanEndpoints.startSession(orderId: orderId))
        guard let session = dto.toDomain() else {
          throw DriverAPIError.malformedPayload("DriverIDScanSession")
        }
        return session
      },
      submitResult: { orderId, verificationId in
        let dto = try await apiClient.send(
          DriverIDScanEndpoints.submitResult(
            orderId: orderId,
            body: DriverIDScanResultRequestDTO(verificationId: verificationId)
          )
        )
        guard let route = dto.toDomain() else {
          throw DriverAPIError.malformedPayload("DriverOrderDetail")
        }
        return route
      }
    )
  }

  static let unimplemented = DriverIDScanAPIClient(
    startSession: { _ in throw DriverAPIError.unimplemented("startIdScanSession") },
    submitResult: { _, _ in throw DriverAPIError.unimplemented("submitIdScanResult") }
  )
}

private enum DriverIDScanAPIClientKey: DependencyKey {
  static let liveValue: DriverIDScanAPIClient = .unimplemented
  static let testValue: DriverIDScanAPIClient = .unimplemented
}

public extension DependencyValues {
  var driverIDScanAPIClient: DriverIDScanAPIClient {
    get { self[DriverIDScanAPIClientKey.self] }
    set { self[DriverIDScanAPIClientKey.self] = newValue }
  }
}
