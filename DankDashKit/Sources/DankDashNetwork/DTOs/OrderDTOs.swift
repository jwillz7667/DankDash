import Foundation
import DankDashDomain

/// Wire shape for `OrderItemResponseSchema`. `productSnapshot` is the
/// per-line snapshot of the catalog row taken at checkout time; we
/// decode it as `AnyValue` so the snapshot's shape can evolve on the
/// server (a new "lab results" pill, a translated brand name) without
/// breaking this DTO. `thcMgTotal` / `cbdMgTotal` / `weightGramsTotal`
/// flow as decimal strings (matches the Phase-17 `ProductDTO` pattern).
public struct OrderItemResponseDTO: Decodable, Sendable, Equatable {
  public let id: String
  public let listingId: String
  public let productSnapshot: AnyValue
  public let quantity: Int
  public let unitPriceCents: Int
  public let lineSubtotalCents: Int
  public let thcMgTotal: String
  public let cbdMgTotal: String
  public let weightGramsTotal: String
  public let cannabisTaxCents: Int
  public let salesTaxCents: Int
  public let createdAt: String

  public init(
    id: String,
    listingId: String,
    productSnapshot: AnyValue,
    quantity: Int,
    unitPriceCents: Int,
    lineSubtotalCents: Int,
    thcMgTotal: String,
    cbdMgTotal: String,
    weightGramsTotal: String,
    cannabisTaxCents: Int,
    salesTaxCents: Int,
    createdAt: String
  ) {
    self.id = id
    self.listingId = listingId
    self.productSnapshot = productSnapshot
    self.quantity = quantity
    self.unitPriceCents = unitPriceCents
    self.lineSubtotalCents = lineSubtotalCents
    self.thcMgTotal = thcMgTotal
    self.cbdMgTotal = cbdMgTotal
    self.weightGramsTotal = weightGramsTotal
    self.cannabisTaxCents = cannabisTaxCents
    self.salesTaxCents = salesTaxCents
    self.createdAt = createdAt
  }
}

public extension OrderItemResponseDTO {
  func toDomain() -> OrderItem? {
    guard let parsedID = CatalogWire.parseUUID(id) else { return nil }
    guard let parsedListingID = CatalogWire.parseUUID(listingId) else { return nil }
    guard let parsedThc = CatalogWire.parseDecimal(thcMgTotal) else { return nil }
    guard let parsedCbd = CatalogWire.parseDecimal(cbdMgTotal) else { return nil }
    guard let parsedWeight = CatalogWire.parseDecimal(weightGramsTotal) else { return nil }
    guard let parsedCreated = CatalogWire.parseISO8601(createdAt) else { return nil }
    return OrderItem(
      id: parsedID,
      listingId: parsedListingID,
      productSnapshot: productSnapshot,
      quantity: quantity,
      unitPriceCents: unitPriceCents,
      lineSubtotalCents: lineSubtotalCents,
      thcMgTotal: parsedThc,
      cbdMgTotal: parsedCbd,
      weightGramsTotal: parsedWeight,
      cannabisTaxCents: cannabisTaxCents,
      salesTaxCents: salesTaxCents,
      createdAt: parsedCreated
    )
  }
}

/// Wire shape for `OrderResponseSchema` — returned by `POST /v1/carts/:id/checkout`
/// and `GET /v1/orders/:id` (as `OrderDetailResponseDTO.order`). `status`
/// is stringly decoded so an unknown enum value from a server ahead of
/// the client surfaces as a nil-projection rather than a decode crash.
public struct OrderResponseDTO: Decodable, Sendable, Equatable {
  public let id: String
  public let shortCode: String
  public let userId: String
  public let dispensaryId: String
  public let deliveryAddressId: String
  public let status: String
  public let subtotalCents: Int
  public let cannabisTaxCents: Int
  public let salesTaxCents: Int
  public let deliveryFeeCents: Int
  public let driverTipCents: Int
  public let discountCents: Int
  public let totalCents: Int
  public let items: [OrderItemResponseDTO]
  public let placedAt: String
  public let statusChangedAt: String
  public let createdAt: String
  public let updatedAt: String

  public init(
    id: String,
    shortCode: String,
    userId: String,
    dispensaryId: String,
    deliveryAddressId: String,
    status: String,
    subtotalCents: Int,
    cannabisTaxCents: Int,
    salesTaxCents: Int,
    deliveryFeeCents: Int,
    driverTipCents: Int,
    discountCents: Int,
    totalCents: Int,
    items: [OrderItemResponseDTO],
    placedAt: String,
    statusChangedAt: String,
    createdAt: String,
    updatedAt: String
  ) {
    self.id = id
    self.shortCode = shortCode
    self.userId = userId
    self.dispensaryId = dispensaryId
    self.deliveryAddressId = deliveryAddressId
    self.status = status
    self.subtotalCents = subtotalCents
    self.cannabisTaxCents = cannabisTaxCents
    self.salesTaxCents = salesTaxCents
    self.deliveryFeeCents = deliveryFeeCents
    self.driverTipCents = driverTipCents
    self.discountCents = discountCents
    self.totalCents = totalCents
    self.items = items
    self.placedAt = placedAt
    self.statusChangedAt = statusChangedAt
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }
}

public extension OrderResponseDTO {
  /// Lossy projection. Returns nil for any malformed scalar field or
  /// item row — the order is the system of record for what the user
  /// paid, so partial decoding is not acceptable here.
  func toDomain() -> Order? {
    guard let parsedID = CatalogWire.parseUUID(id) else { return nil }
    guard let parsedUserID = CatalogWire.parseUUID(userId) else { return nil }
    guard let parsedDispensaryID = CatalogWire.parseUUID(dispensaryId) else { return nil }
    guard let parsedAddressID = CatalogWire.parseUUID(deliveryAddressId) else { return nil }
    guard let parsedStatus = OrderStatus(rawValue: status) else { return nil }
    guard let parsedPlacedAt = CatalogWire.parseISO8601(placedAt) else { return nil }
    guard let parsedStatusChangedAt = CatalogWire.parseISO8601(statusChangedAt) else { return nil }
    guard let parsedCreated = CatalogWire.parseISO8601(createdAt) else { return nil }
    guard let parsedUpdated = CatalogWire.parseISO8601(updatedAt) else { return nil }
    var parsedItems: [OrderItem] = []
    parsedItems.reserveCapacity(items.count)
    for item in items {
      guard let domain = item.toDomain() else { return nil }
      parsedItems.append(domain)
    }
    return Order(
      id: parsedID,
      shortCode: shortCode,
      userId: parsedUserID,
      dispensaryId: parsedDispensaryID,
      deliveryAddressId: parsedAddressID,
      status: parsedStatus,
      subtotalCents: subtotalCents,
      cannabisTaxCents: cannabisTaxCents,
      salesTaxCents: salesTaxCents,
      deliveryFeeCents: deliveryFeeCents,
      driverTipCents: driverTipCents,
      discountCents: discountCents,
      totalCents: totalCents,
      items: parsedItems,
      placedAt: parsedPlacedAt,
      statusChangedAt: parsedStatusChangedAt,
      createdAt: parsedCreated,
      updatedAt: parsedUpdated
    )
  }
}

/// Wire shape for `OrderEventResponseSchema`. `payload` is `AnyValue`
/// because the shape varies per `eventType` — clients discriminate on
/// `eventType` and read the keys they know about. Driver-location
/// events are intentionally absent from this stream (they ship over
/// the realtime socket).
public struct OrderEventResponseDTO: Decodable, Sendable, Equatable {
  public let id: String
  public let orderId: String
  public let eventType: String
  public let actorUserId: String?
  public let actorRole: String?
  public let payload: AnyValue
  public let occurredAt: String

  public init(
    id: String,
    orderId: String,
    eventType: String,
    actorUserId: String?,
    actorRole: String?,
    payload: AnyValue,
    occurredAt: String
  ) {
    self.id = id
    self.orderId = orderId
    self.eventType = eventType
    self.actorUserId = actorUserId
    self.actorRole = actorRole
    self.payload = payload
    self.occurredAt = occurredAt
  }
}

public extension OrderEventResponseDTO {
  func toDomain() -> OrderEvent? {
    guard let parsedID = CatalogWire.parseUUID(id) else { return nil }
    guard let parsedOrderID = CatalogWire.parseUUID(orderId) else { return nil }
    guard let parsedOccurredAt = CatalogWire.parseISO8601(occurredAt) else { return nil }
    let parsedActor: UUID?
    if let actorUserId {
      guard let parsed = CatalogWire.parseUUID(actorUserId) else { return nil }
      parsedActor = parsed
    } else {
      parsedActor = nil
    }
    return OrderEvent(
      id: parsedID,
      orderId: parsedOrderID,
      eventType: eventType,
      actorUserId: parsedActor,
      actorRole: actorRole,
      payload: payload,
      occurredAt: parsedOccurredAt
    )
  }
}

/// Wire shape for `OrderDetailResponseSchema` — the order-tracking
/// screen's single-call refresh shape (order + events + optional
/// driver). The events array is server-sorted ASC by `occurredAt`.
public struct OrderDetailResponseDTO: Decodable, Sendable, Equatable {
  public let order: OrderResponseDTO
  public let events: [OrderEventResponseDTO]
  public let driver: DriverPublicProfileDTO?

  public init(
    order: OrderResponseDTO,
    events: [OrderEventResponseDTO],
    driver: DriverPublicProfileDTO?
  ) {
    self.order = order
    self.events = events
    self.driver = driver
  }
}

public extension OrderDetailResponseDTO {
  /// Lossy projection. Returns nil if the order projection fails (the
  /// whole screen needs the order to render); events that fail to
  /// project are silently dropped (a malformed event row shouldn't
  /// hide the whole timeline). Driver projection failure also drops
  /// to nil — the screen renders the "driver assignment pending" state
  /// in that case.
  func toDomain() -> Domain? {
    guard let parsedOrder = order.toDomain() else { return nil }
    let parsedEvents = events.compactMap { $0.toDomain() }
    let parsedDriver = driver?.toDomain()
    return Domain(order: parsedOrder, events: parsedEvents, driver: parsedDriver)
  }

  /// Domain projection of the detail response. Lives on the DTO because
  /// the three values together are not a stand-alone Domain type — the
  /// reducer needs them as separate slices and never wraps them again.
  struct Domain: Sendable, Equatable {
    public let order: Order
    public let events: [OrderEvent]
    public let driver: DriverPublicProfile?

    public init(order: Order, events: [OrderEvent], driver: DriverPublicProfile?) {
      self.order = order
      self.events = events
      self.driver = driver
    }
  }
}

/// Wire shape for `OrderListItemSchema` — slim list-row projection
/// returned by `GET /v1/orders`. Drops items + compliance snapshot +
/// event log; loads them on demand via the detail endpoint.
public struct OrderListItemDTO: Decodable, Sendable, Equatable {
  public let id: String
  public let shortCode: String
  public let dispensaryId: String
  public let status: String
  public let totalCents: Int
  public let placedAt: String
  public let statusChangedAt: String

  public init(
    id: String,
    shortCode: String,
    dispensaryId: String,
    status: String,
    totalCents: Int,
    placedAt: String,
    statusChangedAt: String
  ) {
    self.id = id
    self.shortCode = shortCode
    self.dispensaryId = dispensaryId
    self.status = status
    self.totalCents = totalCents
    self.placedAt = placedAt
    self.statusChangedAt = statusChangedAt
  }
}

public extension OrderListItemDTO {
  func toDomain() -> OrderListItem? {
    guard let parsedID = CatalogWire.parseUUID(id) else { return nil }
    guard let parsedDispensaryID = CatalogWire.parseUUID(dispensaryId) else { return nil }
    guard let parsedStatus = OrderStatus(rawValue: status) else { return nil }
    guard let parsedPlacedAt = CatalogWire.parseISO8601(placedAt) else { return nil }
    guard let parsedStatusChangedAt = CatalogWire.parseISO8601(statusChangedAt) else { return nil }
    return OrderListItem(
      id: parsedID,
      shortCode: shortCode,
      dispensaryId: parsedDispensaryID,
      status: parsedStatus,
      totalCents: totalCents,
      placedAt: parsedPlacedAt,
      statusChangedAt: parsedStatusChangedAt
    )
  }
}

/// Wire shape for `OrderListResponseSchema`. `nextCursor: nil` marks
/// the last page so the client knows to stop paginating.
public struct OrderListResponseDTO: Decodable, Sendable, Equatable {
  public let items: [OrderListItemDTO]
  public let nextCursor: String?

  public init(items: [OrderListItemDTO], nextCursor: String?) {
    self.items = items
    self.nextCursor = nextCursor
  }

  /// Projects to a `(items, nextCursor)` Domain pair. List rows that
  /// fail to project (an unknown status, a bad UUID) are silently
  /// dropped — one bad row shouldn't black-hole the entire Orders tab.
  public func toDomain() -> Domain {
    Domain(items: items.compactMap { $0.toDomain() }, nextCursor: nextCursor)
  }

  public struct Domain: Sendable, Equatable {
    public let items: [OrderListItem]
    public let nextCursor: String?

    public init(items: [OrderListItem], nextCursor: String?) {
      self.items = items
      self.nextCursor = nextCursor
    }
  }
}
