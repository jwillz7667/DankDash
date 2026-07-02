import Foundation

/// Server-cart projection — mirror of `CartResponse` (the response of
/// `POST /v1/carts`, `GET /v1/carts/:id`, item add / patch / remove).
/// Replaces the in-memory `LocalCartDraft` the moment the user enters
/// the Cart tab with items: the draft promotes to a server cart (one
/// POST + one item-POST per line + one validate) and the server becomes
/// the source of truth.
///
/// `subtotalCents` is the sum of `lineSubtotalCents` across `items` —
/// the server computes it and the iOS client renders it as-is. Tax /
/// delivery fee / tip / total are NOT on this projection; they appear
/// after validate (Phase 5.2) and after checkout (Phase 5.3). Rendering
/// a fictitious tax here would invite the client to overwrite a number
/// it already has correct.
///
/// `expiresAt` is the soft TTL — the server refreshes it on every read
/// or mutation. The iOS Cart screen surfaces a countdown banner when
/// `expiresAt` is < 5 minutes out and refreshes the cart with a no-op
/// read (which itself bumps the TTL) when the screen reappears.
public struct Cart: Identifiable, Hashable, Sendable, Codable {
  public let id: UUID
  public let userId: UUID
  public let dispensaryId: UUID
  public let items: [CartItem]
  public let subtotalCents: Int

  /// Applied promotion code, or `nil` when no promo is on the cart. The
  /// server is authoritative — the iOS client renders whatever code the
  /// last mutation returned rather than echoing the user's raw input.
  public let promoCode: String?

  /// Current promo discount in integer cents, always `>= 0`. Rendered as
  /// a negative line in the totals stripe. `0` when no promo applies.
  public let discountCents: Int

  public let expiresAt: Date
  public let createdAt: Date
  public let updatedAt: Date

  public init(
    id: UUID,
    userId: UUID,
    dispensaryId: UUID,
    items: [CartItem],
    subtotalCents: Int,
    promoCode: String? = nil,
    discountCents: Int = 0,
    expiresAt: Date,
    createdAt: Date,
    updatedAt: Date
  ) {
    self.id = id
    self.userId = userId
    self.dispensaryId = dispensaryId
    self.items = items
    self.subtotalCents = subtotalCents
    self.promoCode = promoCode
    self.discountCents = discountCents
    self.expiresAt = expiresAt
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }

  public var isEmpty: Bool { items.isEmpty }
  public var totalQuantity: Int { items.reduce(0) { $0 + $1.quantity } }

  /// Subtotal net of the promo discount, floored at zero. The server owns
  /// tax / delivery fee / tip, so this is the discounted goods total, not
  /// the final order total.
  public var discountedSubtotalCents: Int { max(0, subtotalCents - discountCents) }

  /// Whether a promo code is currently applied to the cart.
  public var hasPromo: Bool { promoCode != nil }
}

/// One line on a server cart — the (cart × listing) join with the
/// snapshotted unit price + computed line subtotal. Wire shape mirrors
/// `CartItemResponse`.
///
/// Brand / product name / image keys are NOT on this line — the iOS
/// client joins against its cached menu / product detail by `listingId`
/// to render the row. Embedding the product card here would force every
/// catalog cache-invalidation surface to also invalidate cart reads,
/// and the consumer is in the same session as the menu read ≥99% of
/// the time anyway.
public struct CartItem: Identifiable, Hashable, Sendable, Codable {
  public let id: UUID
  public let listingId: UUID
  public let quantity: Int
  public let unitPriceCents: Int
  public let lineSubtotalCents: Int
  public let createdAt: Date
  public let updatedAt: Date

  public init(
    id: UUID,
    listingId: UUID,
    quantity: Int,
    unitPriceCents: Int,
    lineSubtotalCents: Int,
    createdAt: Date,
    updatedAt: Date
  ) {
    self.id = id
    self.listingId = listingId
    self.quantity = quantity
    self.unitPriceCents = unitPriceCents
    self.lineSubtotalCents = lineSubtotalCents
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }
}
