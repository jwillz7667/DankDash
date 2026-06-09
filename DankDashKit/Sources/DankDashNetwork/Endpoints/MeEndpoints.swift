import Foundation

public enum MeEndpoints {
  public static func current() -> Endpoint<UserSummaryDTO> {
    Endpoint(method: .GET, path: "v1/me", requiresAuth: true)
  }

  /// `PATCH /v1/me` — narrow self-service profile edit (first/last name
  /// only). Returns the refreshed `MeResponse`, which is a superset of
  /// `UserSummaryDTO`; the extra keys decode away.
  public static func updateProfile(body: UpdateMeRequestDTO) -> Endpoint<UserSummaryDTO> {
    Endpoint(method: .PATCH, path: "v1/me", body: AnyEncodableBody(body), requiresAuth: true)
  }
}
