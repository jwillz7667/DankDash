import Foundation

/// Addresses endpoint catalog — read, create, edit, promote, and delete
/// the saved delivery addresses for the authenticated user. All require
/// auth; RLS hides addresses owned by other users, and the service layer
/// returns 404 (not 403) on a cross-user id so a probe can't distinguish
/// ownership from existence.
///
/// Delete is a soft-delete (`deleted_at` stamped, default flag cleared);
/// the row is retained for order-history referential integrity and simply
/// vanishes from `listAddresses`.
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

  /// `PATCH /v1/addresses/:id` — full-form edit. Same route as
  /// ``patchAddress(id:body:)`` but the ``EditAddressRequestDTO`` body
  /// ships every field, encoding `label` / `line2` / `deliveryInstructions`
  /// as explicit `null` when the user cleared them so the edit actually
  /// removes the prior value (a `PatchAddressRequestDTO` would omit the
  /// key and leave it intact).
  public static func editAddress(
    id: UUID,
    body: EditAddressRequestDTO
  ) -> Endpoint<UserAddressResponseDTO> {
    Endpoint(
      method: .PATCH,
      path: "v1/addresses/\(id.uuidString.lowercased())",
      body: AnyEncodableBody(body),
      requiresAuth: true
    )
  }

  /// `DELETE /v1/addresses/:id` — soft-delete. 204 No Content on success
  /// (hence `EmptyResponse`). A cross-user / missing / already-deleted id
  /// returns 404. Deleting the current default leaves the account with no
  /// default until the user promotes another address.
  public static func deleteAddress(id: UUID) -> Endpoint<EmptyResponse> {
    Endpoint(
      method: .DELETE,
      path: "v1/addresses/\(id.uuidString.lowercased())",
      requiresAuth: true
    )
  }
}
