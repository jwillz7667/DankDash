import Foundation

/// Open-pool delivery endpoints (driver-facing):
///
///   GET  /v1/driver/deliveries/available       — claimable ready orders
///   POST /v1/driver/deliveries/:orderId/claim   — first-come claim
///
/// The open pool is the untargeted counterpart to ``DriverOffersEndpoints``:
/// instead of one timed offer per driver, every eligible online driver
/// sees the same board and the first to claim wins (a second claimer gets
/// a 409). The dasher map polls `available` on the shift cadence and POSTs
/// `claim` when the driver taps Accept in the detail sheet.
public enum DriverDeliveriesEndpoints {
  public static func availableDeliveries() -> Endpoint<AvailableDeliveriesResponseDTO> {
    Endpoint(
      method: .GET,
      path: "v1/driver/deliveries/available",
      requiresAuth: true
    )
  }

  public static func claimDelivery(orderId: UUID) -> Endpoint<ClaimDeliveryResponseDTO> {
    Endpoint(
      method: .POST,
      path: "v1/driver/deliveries/\(orderId.uuidString.lowercased())/claim",
      requiresAuth: true
    )
  }
}
