import Foundation

/// Driver-self ID-scan endpoints — Phase 20.3. Sits alongside
/// `DriverOrdersEndpoints`; kept in a separate file because both
/// endpoints route through `DriverIdScanService` on the backend and
/// the reducer that drives them (``IDScanFeature``) takes a dedicated
/// `DriverIDScanAPIClient` dependency rather than fold these calls
/// into the active-route client (different ownership, different
/// retry semantics).
///
///   POST /v1/driver/orders/:id/id-scan-session
///     no body — creates a Veriff session and stashes the
///     verificationId on the order. Returns the SDK launch payload.
///
///   POST /v1/driver/orders/:id/id-scan-result
///     body: { verificationId } — driver's SDK reported a terminal
///     callback. Backend fetches the authoritative decision from
///     Veriff and writes the outcome idempotently; the response is
///     the full refreshed `DriverOrderDetailResponse`.
public enum DriverIDScanEndpoints {
  public static func startSession(orderId: UUID) -> Endpoint<DriverIDScanSessionResponseDTO> {
    Endpoint(
      method: .POST,
      path: "v1/driver/orders/\(orderId.uuidString.lowercased())/id-scan-session",
      requiresAuth: true
    )
  }

  public static func submitResult(
    orderId: UUID,
    body: DriverIDScanResultRequestDTO
  ) -> Endpoint<DriverOrderDetailResponseDTO> {
    Endpoint(
      method: .POST,
      path: "v1/driver/orders/\(orderId.uuidString.lowercased())/id-scan-result",
      body: AnyEncodableBody(body),
      requiresAuth: true
    )
  }
}
