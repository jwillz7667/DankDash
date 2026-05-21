import Foundation

/// Driver-self order surface — Phase 20.2 + 20.3. Sits alongside
/// `DriverShiftEndpoints` and `DriverOffersEndpoints` and routes
/// through the same `DriverContextGuard` + `RolesGuard('driver')` chain
/// on the backend:
///
///   GET  /v1/driver/orders/:id            — denormalized route view
///   POST /v1/driver/orders/:id/pickup-confirm
///   POST /v1/driver/orders/:id/delivery-confirm
///
/// All three require an authenticated driver JWT. The `id` segment is
/// always lowercased — the backend canonicalizes to lowercase UUIDs
/// in URLs and an upper-case path would miss a route-handler match in
/// case-sensitive proxies.
public enum DriverOrdersEndpoints {
  /// Fetches the driver's denormalized view of one order. The response
  /// is the system-of-record at request time; the reducer projects it
  /// to `ActiveRoute` and treats the server's `order.status` as
  /// authoritative for the leg transition.
  public static func getOrder(id: UUID) -> Endpoint<DriverOrderDetailResponseDTO> {
    Endpoint(
      method: .GET,
      path: "v1/driver/orders/\(id.uuidString.lowercased())",
      requiresAuth: true
    )
  }

  /// Transitions the order `accepted → en_route_pickup`. Server emits
  /// an immutable `order_events` row and records the captured location
  /// on the event payload. The response is the FULL refreshed order
  /// detail (no second GET needed).
  public static func pickupConfirm(
    id: UUID,
    body: DriverPickupConfirmRequestDTO
  ) -> Endpoint<DriverOrderDetailResponseDTO> {
    Endpoint(
      method: .POST,
      path: "v1/driver/orders/\(id.uuidString.lowercased())/pickup-confirm",
      body: AnyEncodableBody(body),
      requiresAuth: true
    )
  }

  /// Transitions the order to `delivered`. The server REJECTS with 409
  /// `ID_SCAN_REQUIRED` if `delivery_id_scan_passed != true` — the
  /// reducer treats that response as a defensive guard (the UI never
  /// surfaces the button until the scan reducer reports `passed`, but
  /// the server gate is the real protection).
  public static func deliveryConfirm(
    id: UUID,
    body: DriverDeliveryConfirmRequestDTO
  ) -> Endpoint<DriverOrderDetailResponseDTO> {
    Endpoint(
      method: .POST,
      path: "v1/driver/orders/\(id.uuidString.lowercased())/delivery-confirm",
      body: AnyEncodableBody(body),
      requiresAuth: true
    )
  }
}
