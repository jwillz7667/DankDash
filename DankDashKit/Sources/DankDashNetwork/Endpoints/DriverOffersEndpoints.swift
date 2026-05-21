import Foundation

/// Driver dispatch-offer responses (Phase 8.4):
///
///   GET  /v1/driver/offers/pending       — list of `offered` rows for me
///   POST /v1/driver/offers/:id/accept
///   POST /v1/driver/offers/:id/decline   { reason? }
///
/// The `GET` lands in Phase 20 as the polling fallback for offer
/// delivery (Socket.io `/driver` namespace is deferred to Phase 22); the
/// `POST` halves were wired in Phase 8 so the realtime decoder can
/// reuse the DTO shape without a follow-up touch.
public enum DriverOffersEndpoints {
  /// Driver-self list of pending dispatch offers. Server filters by the
  /// authenticated driver and `status = 'offered'`. The iOS
  /// ``OfferSubscriptionClient`` polls this every 10 seconds while a
  /// shift is active; once Phase 22 lights up the `/driver` namespace
  /// the subscription swaps to socket without changing the wire shape.
  public static func pendingOffers() -> Endpoint<PendingOffersResponseDTO> {
    Endpoint(
      method: .GET,
      path: "v1/driver/offers/pending",
      requiresAuth: true
    )
  }

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
