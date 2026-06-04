import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// `@DependencyClient`-style abstraction over the driver shift
/// endpoints (`POST /v1/driver/shift/start|end`, `POST /v1/driver/status`).
/// Reducers depend on this struct rather than `APIClient` so TestStore
/// tests substitute typed closures.
public struct DriverShiftAPIClient: Sendable {
  public var startShift: @Sendable (Coordinate) async throws -> DriverShift
  public var endShift: @Sendable (Coordinate) async throws -> DriverShift
  public var updateStatus: @Sendable (SelfSettableDriverStatus) async throws -> Driver

  public init(
    startShift: @Sendable @escaping (Coordinate) async throws -> DriverShift,
    endShift: @Sendable @escaping (Coordinate) async throws -> DriverShift,
    updateStatus: @Sendable @escaping (SelfSettableDriverStatus) async throws -> Driver
  ) {
    self.startShift = startShift
    self.endShift = endShift
    self.updateStatus = updateStatus
  }
}

public extension DriverShiftAPIClient {
  static func live(apiClient: APIClient) -> DriverShiftAPIClient {
    DriverShiftAPIClient(
      startShift: { coord in
        let dto = try await apiClient.send(
          DriverShiftEndpoints.startShift(body: StartShiftRequestDTO(startingLocation: coord))
        )
        guard let shift = dto.toDomain() else {
          throw DriverAPIError.malformedPayload("DriverShift")
        }
        return shift
      },
      endShift: { coord in
        let dto = try await apiClient.send(
          DriverShiftEndpoints.endShift(body: EndShiftRequestDTO(endingLocation: coord))
        )
        guard let shift = dto.toDomain() else {
          throw DriverAPIError.malformedPayload("DriverShift")
        }
        return shift
      },
      updateStatus: { status in
        let dto = try await apiClient.send(
          DriverShiftEndpoints.updateStatus(body: UpdateDriverStatusRequestDTO(status: status))
        )
        guard let driver = dto.toDomain() else {
          throw DriverAPIError.malformedPayload("Driver")
        }
        return driver
      }
    )
  }

  static let unimplemented = DriverShiftAPIClient(
    startShift: { _ in throw DriverAPIError.unimplemented("startShift") },
    endShift: { _ in throw DriverAPIError.unimplemented("endShift") },
    updateStatus: { _ in throw DriverAPIError.unimplemented("updateStatus") }
  )
}

/// Shared error type for the driver-side API clients. Reducers pattern
/// match on these so they don't transitively depend on `APIError`.
public enum DriverAPIError: Error, Sendable, Equatable {
  case malformedPayload(String)
  case unimplemented(String)
}

private enum DriverShiftAPIClientKey: DependencyKey {
  static let liveValue: DriverShiftAPIClient = .unimplemented
  static let testValue: DriverShiftAPIClient = .unimplemented
}

public extension DependencyValues {
  var driverShiftAPIClient: DriverShiftAPIClient {
    get { self[DriverShiftAPIClientKey.self] }
    set { self[DriverShiftAPIClientKey.self] = newValue }
  }
}
