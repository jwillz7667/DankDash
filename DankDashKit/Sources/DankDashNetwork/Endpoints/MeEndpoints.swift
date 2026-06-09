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

  /// `DELETE /v1/me` — irreversible account deletion. The server anonymizes
  /// the identity-root PII, revokes every session, and soft-deletes the
  /// caller's addresses + payment methods in one transaction; it returns 200
  /// with a thin `{ deletedAt }` acknowledgement. The client doesn't need the
  /// tombstone timestamp, so the body is discarded into `EmptyResponse`
  /// (`EmptyResponse.init(from:)` ignores any keys). A 409 is returned when
  /// the account still has an order in flight.
  public static func deleteAccount() -> Endpoint<EmptyResponse> {
    Endpoint(method: .DELETE, path: "v1/me", requiresAuth: true)
  }
}
