import Foundation

/// Driver-self application submission (Phase 8 deferred):
///
///   POST /v1/driver/applications
///
/// The backend endpoint is documented as deferred in Phase 19's
/// PROGRESS.md. On 404 the iOS reducer transitions the onboarding flow
/// to `.pending` with a `queued = true` flag so the UI shows
/// "Application queued — an admin will reach out". Once the endpoint
/// ships, the same DTO + endpoint factory route the submission
/// without a follow-up touch.
public enum DriverOnboardingEndpoints {
  public static func submitApplication(body: DriverApplicationRequestDTO) -> Endpoint<DriverApplicationResponseDTO> {
    Endpoint(
      method: .POST,
      path: "v1/driver/applications",
      body: AnyEncodableBody(body),
      requiresAuth: true
    )
  }
}
