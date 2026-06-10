import Foundation

/// Driver-self order surface — Phase 20.2 + 20.3. Sits alongside
/// `DriverShiftEndpoints` and `DriverOffersEndpoints` and routes
/// through the same `DriverContextGuard` + `RolesGuard('driver')` chain
/// on the backend:
///
///   GET  /v1/driver/orders/:id            — denormalized route view
///   POST /v1/driver/orders/:id/pickup-confirm
///   POST /v1/driver/orders/:id/cancel     — pre-custody bail-out
///   POST /v1/driver/orders/:id/depart
///   POST /v1/driver/orders/:id/arrive
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

  /// Pre-custody bail-out: `driver_assigned | en_route_pickup →
  /// awaiting_driver`. Only valid before pickup-confirm hands the bag
  /// over — the machine 422s from `picked_up` onward (cannabis in the
  /// car can only end in delivery or return-to-store). The response is
  /// the minimal cancel shape, NOT the detail bundle: after the
  /// transition the order belongs to dispatch again and the detail GET
  /// would 404 for this driver by construction.
  public static func cancel(
    id: UUID,
    body: DriverCancelDeliveryRequestDTO
  ) -> Endpoint<DriverCancelDeliveryResponseDTO> {
    Endpoint(
      method: .POST,
      path: "v1/driver/orders/\(id.uuidString.lowercased())/cancel",
      body: AnyEncodableBody(body),
      requiresAuth: true
    )
  }

  /// Transitions the order `picked_up → en_route_dropoff` once the
  /// driver leaves the store with the package. The response is the full
  /// refreshed order detail; the reducer flips to the dropoff leg and
  /// recalculates directions from the latest fix.
  public static func depart(
    id: UUID,
    body: DriverDepartRequestDTO
  ) -> Endpoint<DriverOrderDetailResponseDTO> {
    Endpoint(
      method: .POST,
      path: "v1/driver/orders/\(id.uuidString.lowercased())/depart",
      body: AnyEncodableBody(body),
      requiresAuth: true
    )
  }

  /// Transitions the order `en_route_dropoff → arrived_at_dropoff` when
  /// the driver reaches the customer. This MUST land before the ID-scan
  /// session opens — `id-scan-session` 409s from any earlier state — so
  /// the reducer awaits this response before delegating to the scan.
  public static func arrive(
    id: UUID,
    body: DriverArriveRequestDTO
  ) -> Endpoint<DriverOrderDetailResponseDTO> {
    Endpoint(
      method: .POST,
      path: "v1/driver/orders/\(id.uuidString.lowercased())/arrive",
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
