import Foundation

/// Driver dispatch-offer responses (Phase 8.4):
///
///   POST /v1/driver/offers/:id/accept
///   POST /v1/driver/offers/:id/decline   { reason? }
///
/// Phase 19's iOS app does not yet render the offer card — that lights
/// up in Phase 20 — but the endpoints are wired here so the realtime
/// `/driver` namespace decoder (Phase 22) can use the same DTO shapes
/// without a follow-up touch.
public enum DriverOffersEndpoints {
  public static func acceptOffer(id: UUID) -> Endpoint<DispatchOfferResponseDTO> {
    Endpoint(
      method: .POST,
      path: "v1/driver/offers/\(id.uuidString.lowercased())/accept",
      requiresAuth: true
    )
  }

  public static func declineOffer(id: UUID, body: DeclineOfferRequestDTO) -> Endpoint<DispatchOfferResponseDTO> {
    Endpoint(
      method: .POST,
      path: "v1/driver/offers/\(id.uuidString.lowercased())/decline",
      body: AnyEncodableBody(body),
      requiresAuth: true
    )
  }
}
