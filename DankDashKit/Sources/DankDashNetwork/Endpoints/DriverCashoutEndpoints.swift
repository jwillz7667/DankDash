import Foundation

/// Driver cashout surface — Phase 20.4. Sits alongside the rest of the
/// `/v1/driver/*` family and routes through the same
/// `DriverContextGuard` + `RolesGuard('driver')` chain on the backend.
///
///   POST /v1/driver/cashout
///
/// The endpoint persists a row in the `payouts` ledger after a
/// server-side balance check; on overdraw it answers 422 with envelope
/// code `PAYMENT_AMOUNT_MISMATCH`. Until the Aeropay live integration
/// lands (deferred per Phase 20 scope decisions in ADR 0007) the
/// upstream call is a stub — the row is the system of record and ops
/// processes it manually.
public enum DriverCashoutEndpoints {
  /// Request a cashout of `amountCents` from the driver's accrued
  /// lifetime earnings minus outstanding payouts. The response is the
  /// freshly-persisted `payouts` row, projected to ``CashoutRequest``
  /// by ``DriverCashoutAPIClient``.
  public static func requestCashout(
    body: DriverCashoutRequestDTO
  ) -> Endpoint<DriverCashoutResponseDTO> {
    Endpoint(
      method: .POST,
      path: "v1/driver/cashout",
      body: AnyEncodableBody(body),
      requiresAuth: true
    )
  }
}
