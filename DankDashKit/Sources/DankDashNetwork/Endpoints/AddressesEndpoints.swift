import Foundation

/// Addresses endpoint catalog — read, create, partial-update the saved
/// delivery addresses for the authenticated user. All require auth; RLS
/// hides addresses owned by other users. Deletion isn't exposed in
/// Phase 18 (the address picker uses isDefault / archive flags
/// server-side; hard delete lives in a later phase).
public enum AddressesEndpoints {
  /// `GET /v1/addresses` — server returns non-archived addresses,
  /// default-first. The picker uses the same ordering so the row at
  /// index 0 is always the default candidate.
  public static func listAddresses() -> Endpoint<ListAddressesResponseDTO> {
    Endpoint(
      method: .GET,
      path: "v1/addresses",
      requiresAuth: true
    )
  }

  /// `POST /v1/addresses` — geocoded server-side via the Phase-8
  /// geocoder client. `setAsDefault: true` promotes the new row in the
  /// same transaction (clears whatever row currently holds the
  /// singleton default); the picker sets that flag on the user's first
  /// address or on an explicit "save as default" toggle.
  public static func createAddress(
    body: CreateAddressRequestDTO
  ) -> Endpoint<UserAddressResponseDTO> {
    Endpoint(
      method: .POST,
      path: "v1/addresses",
      body: AnyEncodableBody(body),
      requiresAuth: true
    )
  }

  /// `PATCH /v1/addresses/:id` — every field is optional but the body
  /// must include at least one (an all-null body returns 422). The
  /// `PatchAddressRequestDTO` custom encoder omits nil keys so a
  /// "promote to default" patch ships exactly `{ "isDefault": true }`.
  public static func patchAddress(
    id: UUID,
    body: PatchAddressRequestDTO
  ) -> Endpoint<UserAddressResponseDTO> {
    Endpoint(
      method: .PATCH,
      path: "v1/addresses/\(id.uuidString.lowercased())",
      body: AnyEncodableBody(body),
      requiresAuth: true
    )
  }
}
