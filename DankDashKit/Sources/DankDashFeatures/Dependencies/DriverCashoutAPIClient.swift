import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// `@DependencyClient`-style abstraction over the driver cashout
/// endpoint — `POST /v1/driver/cashout`. ``DriverEarningsFeature``
/// takes this dependency rather than poking ``APIClient`` directly so
/// the TestStore tests can drive happy-path and 422 insufficient-funds
/// branches deterministically.
///
/// The closure projects the wire DTO down to the ``CashoutRequest``
/// domain value. A malformed projection short-circuits to
/// ``DriverAPIError/malformedPayload`` — the reducer renders that as
/// the same generic banner copy as any other malformed-payload failure.
public struct DriverCashoutAPIClient: Sendable {
  public var requestCashout: @Sendable (Int) async throws -> CashoutRequest

  public init(
    requestCashout: @Sendable @escaping (Int) async throws -> CashoutRequest
  ) {
    self.requestCashout = requestCashout
  }
}

public extension DriverCashoutAPIClient {
  static func live(apiClient: APIClient) -> DriverCashoutAPIClient {
    DriverCashoutAPIClient(
      requestCashout: { amountCents in
        let body = DriverCashoutRequestDTO(amountCents: amountCents)
        let dto = try await apiClient.send(
          DriverCashoutEndpoints.requestCashout(body: body)
        )
        guard let cashout = dto.toDomain() else {
          throw DriverAPIError.malformedPayload("DriverCashoutResponse")
        }
        return cashout
      }
    )
  }

  static let unimplemented = DriverCashoutAPIClient(
    requestCashout: { _ in throw DriverAPIError.unimplemented("requestCashout") }
  )
}

private enum DriverCashoutAPIClientKey: DependencyKey {
  static let liveValue: DriverCashoutAPIClient = .unimplemented
  static let testValue: DriverCashoutAPIClient = .unimplemented
}

public extension DependencyValues {
  var driverCashoutAPIClient: DriverCashoutAPIClient {
    get { self[DriverCashoutAPIClientKey.self] }
    set { self[DriverCashoutAPIClientKey.self] = newValue }
  }
}
