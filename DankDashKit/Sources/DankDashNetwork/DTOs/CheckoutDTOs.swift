import Foundation

/// Wire shape for `CheckoutCapabilitiesResponseSchema`
/// (`GET /v1/checkout/capabilities`). A one-bit probe: whether the server
/// is running the test-only payment bypass. The consumer app reads it on
/// the cart screen to decide whether to surface the in-app "place test
/// order" affordance — in production (flag off) the affordance stays
/// hidden and checkout goes through the Apple §10.4 Safari hand-off.
public struct CheckoutCapabilitiesResponseDTO: Decodable, Sendable, Equatable {
  public let paymentBypassEnabled: Bool

  public init(paymentBypassEnabled: Bool) {
    self.paymentBypassEnabled = paymentBypassEnabled
  }
}

/// Body for `POST /v1/carts/:id/checkout`. Mirrors `CheckoutRequestSchema`.
/// The server treats the body as `.strict()`, so optional fields are
/// `encodeIfPresent` (omitted when nil) rather than emitted as `null` —
/// a stray `null` key would be rejected. UUIDs are lowercased to match
/// the rest of the client's wire convention.
public struct CheckoutRequestDTO: Encodable, Sendable, Equatable {
  public let deliveryAddressId: String
  public let driverTipCents: Int
  public let paymentMethodId: String?
  public let deliveryInstructions: String?

  public init(
    deliveryAddressId: UUID,
    driverTipCents: Int,
    paymentMethodId: UUID? = nil,
    deliveryInstructions: String? = nil
  ) {
    self.deliveryAddressId = deliveryAddressId.uuidString.lowercased()
    self.driverTipCents = driverTipCents
    self.paymentMethodId = paymentMethodId?.uuidString.lowercased()
    self.deliveryInstructions = deliveryInstructions
  }
}

/// Nested `order` projection inside `CheckoutResponseSchema`. The client
/// only needs the order's identity (to route to the order-tracking
/// screen) plus the human-facing short code and status for the
/// confirmation surface — the full order projection is re-fetched by the
/// order-detail screen. Extra keys on the wire are ignored by `Decodable`.
public struct CheckoutOrderDTO: Decodable, Sendable, Equatable {
  public let id: String
  public let shortCode: String
  public let status: String

  public init(id: String, shortCode: String, status: String) {
    self.id = id
    self.shortCode = shortCode
    self.status = status
  }
}

/// Wire shape for `CheckoutResponseSchema` — the envelope returned by a
/// successful `POST /v1/carts/:id/checkout`. The client decodes the
/// `order` (for routing) and `paymentIntent.provider` (to distinguish a
/// real charge from a test-mode bypass on the confirmation surface). The
/// `complianceCheck` block is intentionally not decoded here — the cart
/// screen already holds the evaluation it previewed.
public struct CheckoutResponseDTO: Decodable, Sendable, Equatable {
  public let order: CheckoutOrderDTO
  public let paymentIntent: CheckoutPaymentIntentDTO

  public init(order: CheckoutOrderDTO, paymentIntent: CheckoutPaymentIntentDTO) {
    self.order = order
    self.paymentIntent = paymentIntent
  }
}

/// Nested `paymentIntent` projection. `provider` is `"aeropay"` in the
/// normal flow and `"bypass"` only under the test-only bypass mode.
public struct CheckoutPaymentIntentDTO: Decodable, Sendable, Equatable {
  public let provider: String
  public let status: String

  public init(provider: String, status: String) {
    self.provider = provider
    self.status = status
  }
}

public extension CheckoutResponseDTO {
  /// Parses the created order's id, or nil on a malformed UUID. The
  /// client treats a malformed id as a hard error (it cannot route to
  /// order tracking without it) rather than dropping it silently.
  var orderId: UUID? {
    UUID(uuidString: order.id)
  }
}
