import Foundation

/// Payment-methods endpoint catalog — list, link a bank via Aeropay,
/// promote to default, and delete the consumer's saved payment methods.
/// All require auth; the service returns 404 (not 403) on a cross-user id
/// so a probe can't distinguish ownership from existence.
///
/// Delete is a soft-delete (`deleted_at` stamped, default flag cleared);
/// the row is retained for payment/order referential integrity and simply
/// vanishes from `listPaymentMethods`.
public enum PaymentMethodsEndpoints {
  /// `GET /v1/payment-methods` — the caller's non-deleted methods.
  public static func listPaymentMethods() -> Endpoint<ListPaymentMethodsResponseDTO> {
    Endpoint(
      method: .GET,
      path: "v1/payment-methods",
      requiresAuth: true
    )
  }

  /// `POST /v1/payment-methods/aeropay/link` — starts a hosted bank-link
  /// session. Returns `{ paymentMethod (pending), link }`; the client opens
  /// `link.hostedUrl` in a Safari sheet and the `bank_account.linked`
  /// webhook promotes the row to `active` asynchronously. A 409 is returned
  /// if the user already has a `pending` Aeropay link in flight.
  public static func linkAeropay(
    body: LinkAeropayRequestDTO
  ) -> Endpoint<LinkAeropayResponseDTO> {
    Endpoint(
      method: .POST,
      path: "v1/payment-methods/aeropay/link",
      body: AnyEncodableBody(body),
      requiresAuth: true
    )
  }

  /// `PATCH /v1/payment-methods/:id` — promote a method to the singleton
  /// default. The body is always `{ "isDefault": true }` (the server
  /// rejects anything else); promoting demotes the previous holder
  /// server-side in the same transaction. A non-active method returns 409.
  public static func setDefault(
    id: UUID,
    body: SetDefaultPaymentMethodRequestDTO
  ) -> Endpoint<PaymentMethodEnvelopeResponseDTO> {
    Endpoint(
      method: .PATCH,
      path: "v1/payment-methods/\(id.uuidString.lowercased())",
      body: AnyEncodableBody(body),
      requiresAuth: true
    )
  }

  /// `DELETE /v1/payment-methods/:id` — soft-delete. 204 No Content on
  /// success (hence `EmptyResponse`). A cross-user / missing / already-
  /// deleted id returns 404. Deleting the current default leaves the
  /// account with no default until the user promotes another method.
  public static func deletePaymentMethod(id: UUID) -> Endpoint<EmptyResponse> {
    Endpoint(
      method: .DELETE,
      path: "v1/payment-methods/\(id.uuidString.lowercased())",
      requiresAuth: true
    )
  }
}
