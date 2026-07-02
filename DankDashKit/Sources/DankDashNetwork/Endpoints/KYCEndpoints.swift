import Foundation

/// Consumer KYC endpoint catalog. Single endpoint — the Persona inquiry
/// starter. The outcome is delivered out-of-band to the server via the
/// Persona webhook, so there is no client-facing "submit" or "poll
/// status" endpoint here: the client reads verification state off
/// `GET /v1/me` (`kycVerified`) after the hosted flow returns.
public enum KYCEndpoints {
  /// `POST /v1/identity/kyc/start` — no body, authenticated. Mints a
  /// fresh Persona inquiry for the caller and returns the hosted-flow
  /// URL to open in Safari. Idempotent on the caller side: re-calling
  /// mints a new inquiry (Persona does not resume a prior one), which is
  /// exactly what the "restart verification" affordance needs.
  public static func start() -> Endpoint<KYCStartResponseDTO> {
    Endpoint(method: .POST, path: "v1/identity/kyc/start", requiresAuth: true)
  }
}
