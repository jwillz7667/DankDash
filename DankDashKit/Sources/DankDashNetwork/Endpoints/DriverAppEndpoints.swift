import Foundation
import DankDashDomain

/// Driver-self read surface (Phase 8.5):
///
///   GET /v1/driver/me              — driver self-projection
///   GET /v1/driver/current-route   — active order + pickup + dropoff
///   GET /v1/driver/earnings        — bucketed earnings (today/week/month)
///   GET /v1/driver/shifts          — recent shift history
///
/// `GET /v1/driver/me` is planned but unverified in Phase 8.5; if the
/// route returns 404 the iOS reducer falls back to deriving the
/// driver self-projection from the `POST /v1/driver/status` response
/// (which carries the same `DriverResponse` shape). The graceful-404
/// behaviour lets us ship the driver app ahead of the endpoint.
public enum DriverAppEndpoints {
  public static func getMe() -> Endpoint<DriverResponseDTO> {
    Endpoint(
      method: .GET,
      path: "v1/driver/me",
      requiresAuth: true
    )
  }

  public static func getCurrentRoute() -> Endpoint<CurrentRouteResponseDTO> {
    Endpoint(
      method: .GET,
      path: "v1/driver/current-route",
      requiresAuth: true
    )
  }

  public static func getEarnings(period: EarningsPeriod) -> Endpoint<EarningsResponseDTO> {
    Endpoint(
      method: .GET,
      path: "v1/driver/earnings",
      queryItems: [URLQueryItem(name: "period", value: period.queryValue)],
      requiresAuth: true
    )
  }

  public static func getShifts() -> Endpoint<ShiftsListResponseDTO> {
    Endpoint(
      method: .GET,
      path: "v1/driver/shifts",
      requiresAuth: true
    )
  }
}
