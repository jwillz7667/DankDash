import Foundation

/// Driver-self shift + status HTTP surface (Phase 8.2):
///
///   POST /v1/driver/shift/start    — open shift with starting ping
///   POST /v1/driver/shift/end      — close shift with ending ping
///   POST /v1/driver/status         — switch online/on_break/unavailable
///
/// Auth: every endpoint requires the JWT (the request lands in the
/// backend's `DriverContextGuard` which refuses non-driver principals).
/// Bodies are bounded GeoJSON Points — the iOS reducer hands a
/// `Coordinate` to the DTO's convenience init and the bound check
/// happens server-side.
public enum DriverShiftEndpoints {
  public static func startShift(body: StartShiftRequestDTO) -> Endpoint<DriverShiftResponseDTO> {
    Endpoint(
      method: .POST,
      path: "v1/driver/shift/start",
      body: AnyEncodableBody(body),
      requiresAuth: true
    )
  }

  public static func endShift(body: EndShiftRequestDTO) -> Endpoint<DriverShiftResponseDTO> {
    Endpoint(
      method: .POST,
      path: "v1/driver/shift/end",
      body: AnyEncodableBody(body),
      requiresAuth: true
    )
  }

  /// Backend returns the updated `DriverResponse` so the reducer can
  /// reconcile `lastStatusChangeAt` + `currentStatus` in the same hop
  /// — no follow-up GET needed.
  public static func updateStatus(body: UpdateDriverStatusRequestDTO) -> Endpoint<DriverResponseDTO> {
    Endpoint(
      method: .POST,
      path: "v1/driver/status",
      body: AnyEncodableBody(body),
      requiresAuth: true
    )
  }
}
