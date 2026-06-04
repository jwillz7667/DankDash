import Foundation

/// Cart endpoint catalog. The full surface for the server-cart promotion
/// flow (`CartFeature` swaps the local draft for these calls the moment
/// the user opens the Cart tab) plus the compliance-preview validate.
///
/// All endpoints require auth — the cart is scoped to the authenticated
/// user and RLS rejects cross-user reads at the query layer.
public enum CartEndpoints {
  /// `POST /v1/carts` — idempotent create-or-get. Posting again for the
  /// same `(userId, dispensaryId)` returns the existing cart with a
  /// refreshed 30-min `expiresAt`, so the client doesn't track "do I
  /// already have a cart" state separately from the dispensary id.
  public static func createCart(dispensaryId: UUID) -> Endpoint<CartDTO> {
    Endpoint(
      method: .POST,
      path: "v1/carts",
      body: AnyEncodableBody(CreateCartRequestDTO(dispensaryId: dispensaryId)),
      requiresAuth: true
    )
  }

  /// `GET /v1/carts/:id` — touches the TTL on read so an active session
  /// keeps the cart alive even without mutations.
  public static func getCart(cartId: UUID) -> Endpoint<CartDTO> {
    Endpoint(
      method: .GET,
      path: "v1/carts/\(cartId.uuidString.lowercased())",
      requiresAuth: true
    )
  }

  /// `POST /v1/carts/:id/items` — server treats an add for an existing
  /// `listingId` as an increment of the existing line, so the client
  /// doesn't need to read-then-decide.
  public static func addItem(
    cartId: UUID,
    body: AddCartItemRequestDTO
  ) -> Endpoint<CartDTO> {
    Endpoint(
      method: .POST,
      path: "v1/carts/\(cartId.uuidString.lowercased())/items",
      body: AnyEncodableBody(body),
      requiresAuth: true
    )
  }

  /// `PATCH /v1/carts/:id/items/:itemId` — `quantity: 0` removes the
  /// line idempotently; the server returns the post-mutation cart in
  /// either case.
  public static func patchItem(
    cartId: UUID,
    itemId: UUID,
    body: PatchCartItemRequestDTO
  ) -> Endpoint<CartDTO> {
    Endpoint(
      method: .PATCH,
      path: "v1/carts/\(cartId.uuidString.lowercased())/items/\(itemId.uuidString.lowercased())",
      body: AnyEncodableBody(body),
      requiresAuth: true
    )
  }

  /// `DELETE /v1/carts/:id/items/:itemId` — explicit removal. Equivalent
  /// to `patchItem(quantity: 0)` but kept distinct because the iOS
  /// "swipe to delete" gesture maps to DELETE for log readability.
  public static func removeItem(cartId: UUID, itemId: UUID) -> Endpoint<CartDTO> {
    Endpoint(
      method: .DELETE,
      path: "v1/carts/\(cartId.uuidString.lowercased())/items/\(itemId.uuidString.lowercased())",
      requiresAuth: true
    )
  }

  /// `POST /v1/carts/:id/validate?deliveryAddressId=<uuid>`. Body is
  /// empty; the address rides as a query param so the server can pull
  /// the address row inside the same RLS scope as the cart. Returns 200
  /// on both pass + fail — the `passed` flag plus `rules[]` carry the
  /// verdict.
  public static func validate(
    cartId: UUID,
    deliveryAddressId: UUID
  ) -> Endpoint<ValidateCartResponseDTO> {
    Endpoint(
      method: .POST,
      path: "v1/carts/\(cartId.uuidString.lowercased())/validate",
      queryItems: [
        URLQueryItem(name: "deliveryAddressId", value: deliveryAddressId.uuidString.lowercased())
      ],
      requiresAuth: true
    )
  }

  /// `DELETE /v1/carts/:id` — 204 on success. Used on the "switch
  /// dispensaries" confirmation flow when the user picks a product
  /// outside the active cart's storefront.
  public static func deleteCart(cartId: UUID) -> Endpoint<EmptyResponse> {
    Endpoint(
      method: .DELETE,
      path: "v1/carts/\(cartId.uuidString.lowercased())",
      requiresAuth: true
    )
  }
}
