import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// `@DependencyClient`-style abstraction over the driver-app read
/// surface (`GET /v1/driver/me`, `GET /v1/driver/current-route`,
/// `GET /v1/driver/earnings`, `GET /v1/driver/shifts`).
///
/// `getMe` is the driver-self projection used by the root reducer to
/// decide between onboarding and shift home. The Phase 19 backend
/// surface doesn't yet expose `GET /v1/driver/me` directly — until it
/// lands, the live binding falls back to surfacing
/// `DriverAPIError.endpointNotYetAvailable` on a 404 and the root
/// reducer interprets that as "user is signed in but not a driver"
/// (routing them to onboarding).
public struct DriverAppAPIClient: Sendable {
  public var getMe: @Sendable () async throws -> Driver
  public var getCurrentRoute: @Sendable () async throws -> CurrentRouteState
  public var getEarnings: @Sendable (EarningsPeriod) async throws -> DriverEarnings
  public var getShifts: @Sendable () async throws -> [DriverShift]

  public init(
    getMe: @Sendable @escaping () async throws -> Driver,
    getCurrentRoute: @Sendable @escaping () async throws -> CurrentRouteState,
    getEarnings: @Sendable @escaping (EarningsPeriod) async throws -> DriverEarnings,
    getShifts: @Sendable @escaping () async throws -> [DriverShift]
  ) {
    self.getMe = getMe
    self.getCurrentRoute = getCurrentRoute
    self.getEarnings = getEarnings
    self.getShifts = getShifts
  }
}

public extension DriverAppAPIClient {
  static func live(apiClient: APIClient) -> DriverAppAPIClient {
    DriverAppAPIClient(
      getMe: {
        do {
          let dto = try await apiClient.send(DriverAppEndpoints.getMe())
          guard let driver = dto.toDomain() else {
            throw DriverAPIError.malformedPayload("Driver")
          }
          return driver
        } catch let error as APIError {
          if case .server(let status, _) = error, status == 404 {
            throw DriverAppAPIError.endpointNotYetAvailable
          }
          if case .unexpectedStatus(let status, _) = error, status == 404 {
            throw DriverAppAPIError.endpointNotYetAvailable
          }
          throw error
        }
      },
      getCurrentRoute: {
        let dto = try await apiClient.send(DriverAppEndpoints.getCurrentRoute())
        guard let state = dto.toDomain() else {
          throw DriverAPIError.malformedPayload("CurrentRoute")
        }
        return state
      },
      getEarnings: { period in
        let dto = try await apiClient.send(DriverAppEndpoints.getEarnings(period: period))
        guard let earnings = dto.toDomain() else {
          throw DriverAPIError.malformedPayload("DriverEarnings")
        }
        return earnings
      },
      getShifts: {
        let dto = try await apiClient.send(DriverAppEndpoints.getShifts())
        return dto.toDomain()
      }
    )
  }

  static let unimplemented = DriverAppAPIClient(
    getMe: { throw DriverAPIError.unimplemented("getMe") },
    getCurrentRoute: { throw DriverAPIError.unimplemented("getCurrentRoute") },
    getEarnings: { _ in throw DriverAPIError.unimplemented("getEarnings") },
    getShifts: { throw DriverAPIError.unimplemented("getShifts") }
  )
}

/// Errors specific to the driver app's read surface. Separate from
/// `DriverAPIError` because the root reducer pattern-matches on
/// `.endpointNotYetAvailable` to drive the routing fallback, and that
/// case has no analog on the mutating endpoints.
public enum DriverAppAPIError: Error, Sendable, Equatable {
  /// `GET /v1/driver/me` returned 404 — the Phase 19 backend gap. The
  /// reducer treats this as "signed-in user has no driver record;
  /// route to onboarding."
  case endpointNotYetAvailable
}

private enum DriverAppAPIClientKey: DependencyKey {
  static let liveValue: DriverAppAPIClient = .unimplemented
  static let testValue: DriverAppAPIClient = .unimplemented
}

public extension DependencyValues {
  var driverAppAPIClient: DriverAppAPIClient {
    get { self[DriverAppAPIClientKey.self] }
    set { self[DriverAppAPIClientKey.self] = newValue }
  }
}
