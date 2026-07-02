import Foundation

/// Driver payout bank-account surface — the driver-side analogue of the
/// consumer `PaymentMethodsEndpoints` Aeropay link. Routes through the same
/// `RolesGuard('driver')` chain as the rest of `/v1/driver/*`.
///
///   POST /v1/driver/payouts/bank-account/link
///   GET  /v1/driver/payouts/bank-account
///
/// The driver must have a linked bank account before instant cashout can move
/// money (the server refuses with 422 `PAYMENT_METHOD_INVALID` otherwise).
/// The client opens `link.hostedUrl` in a Safari sheet; the
/// `bank_account.linked` webhook persists the confirmed ref server-side.
public enum DriverPayoutAccountEndpoints {
  /// `POST /v1/driver/payouts/bank-account/link` — start a hosted bank-link
  /// session. Returns `{ link }`; the client opens `link.hostedUrl`.
  public static func startBankLink(
    body: StartDriverBankLinkRequestDTO
  ) -> Endpoint<StartDriverBankLinkResponseDTO> {
    Endpoint(
      method: .POST,
      path: "v1/driver/payouts/bank-account/link",
      body: AnyEncodableBody(body),
      requiresAuth: true
    )
  }

  /// `GET /v1/driver/payouts/bank-account` — read link status (boolean only).
  public static func bankAccountStatus() -> Endpoint<DriverBankAccountStatusResponseDTO> {
    Endpoint(
      method: .GET,
      path: "v1/driver/payouts/bank-account",
      requiresAuth: true
    )
  }
}
