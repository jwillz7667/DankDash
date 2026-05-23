import Foundation

/// Checkout-handoff endpoint catalog. Single endpoint — the one-shot
/// token issuer that bridges the in-app cart to the Apple-§10.4 Safari
/// checkout. The actual payment surface lives at `app.dankdash.com`;
/// iOS never sees a charge form, never holds a Stripe key, and never
/// composes the redirect URL (`exchangeUrl` ships fully-qualified to
/// avoid per-env host typos).
public enum AuthHandoffEndpoints {
  /// `POST /v1/auth/checkout-handoff` — body `{ cartId, deliveryAddressId }`,
  /// response `{ handoffToken, exchangeUrl, expiresAt }`. The token is a
  /// 5-minute single-shot JWT; a second exchange of the same `jti`
  /// returns 401 even if the signature still verifies, so an iOS bug
  /// that resubmits the same Safari load cannot replay the checkout.
  public static func createCheckoutHandoff(
    body: CheckoutHandoffRequestDTO
  ) -> Endpoint<CheckoutHandoffResponseDTO> {
    Endpoint(
      method: .POST,
      path: "v1/auth/checkout-handoff",
      body: AnyEncodableBody(body),
      requiresAuth: true
    )
  }
}
