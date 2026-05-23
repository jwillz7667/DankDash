import Foundation
import DankDashDomain

/// Wire shape of the driver's view of one order. Mirror of the backend
/// `DriverOrderDetailResponseSchema` returned by:
///
///   GET  /v1/driver/orders/:id
///   POST /v1/driver/orders/:id/pickup-confirm
///   POST /v1/driver/orders/:id/delivery-confirm
///
/// The shape is denormalized server-side so the route screen has one
/// hop per leg. `customer`, `dispensary`, `dropoff`, `idScan` are
/// driver-specific projections that don't appear on consumer-facing
/// `OrderDetailResponse`. `events` is ASC by `occurredAt`.
public struct DriverOrderDetailResponseDTO: Decodable, Sendable, Equatable {
  public let order: OrderResponseDTO
  public let events: [OrderEventResponseDTO]
  public let customer: DriverHandoffCustomerDTO
  public let dispensary: DriverHandoffDispensaryDTO
  public let dropoff: DriverHandoffAddressDTO
  public let idScan: DeliveryHandoffDTO

  public init(
    order: OrderResponseDTO,
    events: [OrderEventResponseDTO],
    customer: DriverHandoffCustomerDTO,
    dispensary: DriverHandoffDispensaryDTO,
    dropoff: DriverHandoffAddressDTO,
    idScan: DeliveryHandoffDTO
  ) {
    self.order = order
    self.events = events
    self.customer = customer
    self.dispensary = dispensary
    self.dropoff = dropoff
    self.idScan = idScan
  }
}

public extension DriverOrderDetailResponseDTO {
  /// Lossy projection. The order is the system of record — partial
  /// decoding is not acceptable, so the projection short-circuits to
  /// nil on the first failing scalar. Events that fail to project are
  /// dropped (a malformed event row shouldn't black-hole the timeline).
  func toDomain() -> ActiveRoute? {
    guard let parsedOrder = order.toDomain() else { return nil }
    guard let parsedDispensary = dispensary.toDomain() else { return nil }
    guard let parsedDropoff = dropoff.toDomain() else { return nil }
    guard let parsedIdScan = idScan.toDomain(orderId: parsedOrder.id) else { return nil }
    let parsedEvents = events.compactMap { $0.toDomain() }
    let parsedCustomer = customer.toDomain()
    return ActiveRoute(
      order: parsedOrder,
      customer: parsedCustomer,
      dispensary: parsedDispensary,
      dropoff: parsedDropoff,
      idScan: parsedIdScan,
      events: parsedEvents
    )
  }
}

/// Wire shape of `DriverCustomerSummarySchema`.
public struct DriverHandoffCustomerDTO: Decodable, Sendable, Equatable {
  public let firstName: String?
  public let lastName: String?
  public let maskedPhone: String?

  public init(firstName: String?, lastName: String?, maskedPhone: String?) {
    self.firstName = firstName
    self.lastName = lastName
    self.maskedPhone = maskedPhone
  }

  public func toDomain() -> DriverHandoffCustomer {
    DriverHandoffCustomer(firstName: firstName, lastName: lastName, maskedPhone: maskedPhone)
  }
}

/// Wire shape of `DriverDispensarySummarySchema`. The server projects
/// `state` from the postal address; the iOS domain calls the same
/// field `region` to match the consumer ``UserAddress`` shape.
public struct DriverHandoffDispensaryDTO: Decodable, Sendable, Equatable {
  public let id: String
  public let name: String
  public let addressLine1: String
  public let addressLine2: String?
  public let city: String
  public let state: String
  public let postalCode: String
  public let latitude: Double
  public let longitude: Double
  public let phone: String?

  public init(
    id: String,
    name: String,
    addressLine1: String,
    addressLine2: String?,
    city: String,
    state: String,
    postalCode: String,
    latitude: Double,
    longitude: Double,
    phone: String?
  ) {
    self.id = id
    self.name = name
    self.addressLine1 = addressLine1
    self.addressLine2 = addressLine2
    self.city = city
    self.state = state
    self.postalCode = postalCode
    self.latitude = latitude
    self.longitude = longitude
    self.phone = phone
  }

  public func toDomain() -> DriverHandoffDispensary? {
    guard let parsedID = CatalogWire.parseUUID(id) else { return nil }
    return DriverHandoffDispensary(
      id: parsedID,
      name: name,
      addressLine1: addressLine1,
      addressLine2: addressLine2,
      city: city,
      region: state,
      postalCode: postalCode,
      location: Coordinate(latitude: latitude, longitude: longitude),
      phone: phone
    )
  }
}

/// Wire shape of `DriverDropoffAddressSchema`. Note this is the
/// CHECKOUT-FROZEN snapshot — the server stores the address on
/// `orders.delivery_address_snapshot` so later edits on the user's
/// saved address don't retroactively change the driver's drop.
public struct DriverHandoffAddressDTO: Decodable, Sendable, Equatable {
  public let line1: String
  public let line2: String?
  public let city: String
  public let state: String
  public let postalCode: String
  public let latitude: Double
  public let longitude: Double
  public let instructions: String?

  public init(
    line1: String,
    line2: String?,
    city: String,
    state: String,
    postalCode: String,
    latitude: Double,
    longitude: Double,
    instructions: String?
  ) {
    self.line1 = line1
    self.line2 = line2
    self.city = city
    self.state = state
    self.postalCode = postalCode
    self.latitude = latitude
    self.longitude = longitude
    self.instructions = instructions
  }

  public func toDomain() -> DriverHandoffAddress? {
    DriverHandoffAddress(
      line1: line1,
      line2: line2,
      city: city,
      region: state,
      postalCode: postalCode,
      location: Coordinate(latitude: latitude, longitude: longitude),
      instructions: instructions
    )
  }
}

/// Wire shape of `DriverIdScanStateSchema`. `orderId` is supplied by
/// the projection caller because the wire row does not repeat it
/// (the row is always nested inside the order detail response).
public struct DeliveryHandoffDTO: Decodable, Sendable, Equatable {
  public let passed: Bool
  public let verificationId: String?
  public let scannedAt: String?

  public init(passed: Bool, verificationId: String?, scannedAt: String?) {
    self.passed = passed
    self.verificationId = verificationId
    self.scannedAt = scannedAt
  }

  public func toDomain(orderId: UUID) -> DeliveryHandoff? {
    let parsedScannedAt: Date?
    if let scannedAt {
      guard let resolved = CatalogWire.parseISO8601(scannedAt) else { return nil }
      parsedScannedAt = resolved
    } else {
      parsedScannedAt = nil
    }
    return DeliveryHandoff(
      orderId: orderId,
      passed: passed,
      verificationId: verificationId,
      scannedAt: parsedScannedAt
    )
  }
}
