import Foundation

/// Checkout endpoint catalog.
///
/// `capabilities` is a cart-independent probe the consumer app calls on
/// the cart screen to learn whether the server is in test-only payment-
/// bypass mode. `checkout` is the order-creating call — normally reached
/// only via the Apple §10.4 Safari hand-off (`checkout-web`), but the
/// in-app path is used directly when the bypass is on so order flow can
/// be exercised end-to-end against the vendor portal without payment.
///
/// Both require auth — checkout is scoped to the authenticated customer
/// and RLS rejects cross-user carts at the query layer.
public enum CheckoutEndpoints {
  /// `GET /v1/checkout/capabilities` — `{ paymentBypassEnabled }`.
  public static func capabilities() -> Endpoint<CheckoutCapabilitiesResponseDTO> {
    Endpoint(
      method: .GET,
      path: "v1/checkout/capabilities",
      requiresAuth: true
    )
  }

  /// `POST /v1/carts/:id/checkout` — creates the order (201). The server
  /// re-runs the full compliance evaluation inside the same transaction
  /// that creates the order, so the client's preview is never trusted.
  public static func checkout(
    cartId: UUID,
    body: CheckoutRequestDTO
  ) -> Endpoint<CheckoutResponseDTO> {
    Endpoint(
      method: .POST,
      path: "v1/carts/\(cartId.uuidString.lowercased())/checkout",
      body: AnyEncodableBody(body),
      requiresAuth: true
    )
  }
}
