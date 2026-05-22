import Foundation
import DankDashDomain

/// Pickup-side projection of the dispensary, mirroring the Phase-8
/// `PickupSchema`. The driver app needs just enough to drive to + call
/// the store; the full dispensary projection (delivery polygon, rating,
/// isOpenNow) is overkill for this seat.
public struct PickupDTO: Decodable, Sendable, Equatable {
  public let dispensaryId: String
  public let name: String
  public let addressLine1: String
  public let addressLine2: String?
  public let city: String
  public let region: String
  public let postalCode: String
  public let location: GeoPointDTO
  public let phone: String?
  public let brandColorHex: String?

  public init(
    dispensaryId: String,
    name: String,
    addressLine1: String,
    addressLine2: String?,
    city: String,
    region: String,
    postalCode: String,
    location: GeoPointDTO,
    phone: String?,
    brandColorHex: String?
  ) {
    self.dispensaryId = dispensaryId
    self.name = name
    self.addressLine1 = addressLine1
    self.addressLine2 = addressLine2
    self.city = city
    self.region = region
    self.postalCode = postalCode
    self.location = location
    self.phone = phone
    self.brandColorHex = brandColorHex
  }
}

public extension PickupDTO {
  /// Returns nil if the dispensary id parse fails or the location's
  /// GeoJSON discriminator/tuple is malformed — a pickup with no valid
  /// pin is unusable for routing, fail loud.
  func toDomain() -> Pickup? {
    guard let parsedID = CatalogWire.parseUUID(dispensaryId) else { return nil }
    guard let pair = location.asCoordinate else { return nil }
    return Pickup(
      dispensaryId: parsedID,
      name: name,
      addressLine1: addressLine1,
      addressLine2: addressLine2,
      city: city,
      region: region,
      postalCode: postalCode,
      location: Coordinate(latitude: pair.latitude, longitude: pair.longitude),
      phone: phone,
      brandColorHex: brandColorHex
    )
  }
}

/// Dropoff projection from `orders.delivery_address_snapshot`. Location
/// may be null on legacy rows that predate geocoding — keep the optional
/// at this layer; the UI renders a "tap to call customer" affordance
/// when the pin is missing.
public struct DropoffDTO: Decodable, Sendable, Equatable {
  public let id: String
  public let label: String?
  public let line1: String
  public let line2: String?
  public let city: String
  public let region: String
  public let postalCode: String
  public let country: String
  public let location: GeoPointDTO?
  public let deliveryInstructions: String?

  public init(
    id: String,
    label: String?,
    line1: String,
    line2: String?,
    city: String,
    region: String,
    postalCode: String,
    country: String,
    location: GeoPointDTO?,
    deliveryInstructions: String?
  ) {
    self.id = id
    self.label = label
    self.line1 = line1
    self.line2 = line2
    self.city = city
    self.region = region
    self.postalCode = postalCode
    self.country = country
    self.location = location
    self.deliveryInstructions = deliveryInstructions
  }
}

public extension DropoffDTO {
  func toDomain() -> Dropoff? {
    guard let parsedID = CatalogWire.parseUUID(id) else { return nil }
    let parsedLocation: Coordinate?
    if let location {
      guard let pair = location.asCoordinate else { return nil }
      parsedLocation = Coordinate(latitude: pair.latitude, longitude: pair.longitude)
    } else {
      parsedLocation = nil
    }
    return Dropoff(
      id: parsedID,
      label: label,
      line1: line1,
      line2: line2,
      city: city,
      region: region,
      postalCode: postalCode,
      country: country,
      location: parsedLocation,
      deliveryInstructions: deliveryInstructions
    )
  }
}

/// Inner shape of `CurrentRouteResponse.activeOrder`. Composes the
/// canonical order projection with the driver-facing pickup + dropoff
/// projections. Sent as a single payload so the route screen can
/// render without N+1 lookups.
public struct ActiveDriverRouteDTO: Decodable, Sendable, Equatable {
  public let order: OrderResponseDTO
  public let pickup: PickupDTO
  public let dropoff: DropoffDTO

  public init(order: OrderResponseDTO, pickup: PickupDTO, dropoff: DropoffDTO) {
    self.order = order
    self.pickup = pickup
    self.dropoff = dropoff
  }
}

public extension ActiveDriverRouteDTO {
  /// Returns nil when any of the three subprojections fails — the
  /// route screen is useless without all three pieces.
  func toDomain() -> ActiveDriverRoute? {
    guard let parsedOrder = order.toDomain() else { return nil }
    guard let parsedPickup = pickup.toDomain() else { return nil }
    guard let parsedDropoff = dropoff.toDomain() else { return nil }
    return ActiveDriverRoute(order: parsedOrder, pickup: parsedPickup, dropoff: parsedDropoff)
  }
}

/// Wire shape of `GET /v1/driver/current-route`. `activeOrder` is null
/// when the driver has no order in flight — the iOS reducer renders the
/// "waiting for offers" screen in that case.
public struct CurrentRouteResponseDTO: Decodable, Sendable, Equatable {
  public let activeOrder: ActiveDriverRouteDTO?

  public init(activeOrder: ActiveDriverRouteDTO?) {
    self.activeOrder = activeOrder
  }
}

public extension CurrentRouteResponseDTO {
  /// Two-state projection: `.none` (no active order — render the
  /// online screen) or `.active(route)` (render the route screen).
  /// Returns nil only when an active route's projection fails;
  /// `activeOrder == null` cleanly maps to `.none` and is the happy
  /// path for the entire "online but unassigned" window.
  func toDomain() -> CurrentRouteState? {
    guard let activeOrder else { return CurrentRouteState.none }
    guard let parsed = activeOrder.toDomain() else { return nil }
    return .active(parsed)
  }
}

/// Domain representation of the current-route projection. Used by the
/// shift / route reducers as the single source of truth for whether a
/// delivery is in flight.
public enum CurrentRouteState: Sendable, Equatable {
  case none
  case active(ActiveDriverRoute)
}

/// Domain bundle for the active-route projection. Lives next to the
/// DTO because it's a single-screen aggregate, not a stand-alone domain
/// concept the reducer slices independently.
public struct ActiveDriverRoute: Sendable, Equatable {
  public let order: Order
  public let pickup: Pickup
  public let dropoff: Dropoff

  public init(order: Order, pickup: Pickup, dropoff: Dropoff) {
    self.order = order
    self.pickup = pickup
    self.dropoff = dropoff
  }
}

/// Driver-side pickup. Lives in Network because it's only used by the
/// driver-app DTOs; promoting it to Domain would add a type that no
/// other layer references.
public struct Pickup: Sendable, Equatable {
  public let dispensaryId: UUID
  public let name: String
  public let addressLine1: String
  public let addressLine2: String?
  public let city: String
  public let region: String
  public let postalCode: String
  public let location: Coordinate
  public let phone: String?
  public let brandColorHex: String?

  public init(
    dispensaryId: UUID,
    name: String,
    addressLine1: String,
    addressLine2: String?,
    city: String,
    region: String,
    postalCode: String,
    location: Coordinate,
    phone: String?,
    brandColorHex: String?
  ) {
    self.dispensaryId = dispensaryId
    self.name = name
    self.addressLine1 = addressLine1
    self.addressLine2 = addressLine2
    self.city = city
    self.region = region
    self.postalCode = postalCode
    self.location = location
    self.phone = phone
    self.brandColorHex = brandColorHex
  }
}

/// Driver-side dropoff projection. Carries `deliveryInstructions` so
/// the route screen surfaces the customer's "gate code 0421" without
/// the driver having to dig.
public struct Dropoff: Sendable, Equatable {
  public let id: UUID
  public let label: String?
  public let line1: String
  public let line2: String?
  public let city: String
  public let region: String
  public let postalCode: String
  public let country: String
  public let location: Coordinate?
  public let deliveryInstructions: String?

  public init(
    id: UUID,
    label: String?,
    line1: String,
    line2: String?,
    city: String,
    region: String,
    postalCode: String,
    country: String,
    location: Coordinate?,
    deliveryInstructions: String?
  ) {
    self.id = id
    self.label = label
    self.line1 = line1
    self.line2 = line2
    self.city = city
    self.region = region
    self.postalCode = postalCode
    self.country = country
    self.location = location
    self.deliveryInstructions = deliveryInstructions
  }
}

/// Wire shape of `GET /v1/driver/earnings`. Period + bounded window +
/// the four counters that drive the earnings card. Money is integer
/// cents (project rule) — never floats.
public struct EarningsResponseDTO: Decodable, Sendable, Equatable {
  public let period: String
  public let since: String
  public let until: String
  public let tipsCents: Int
  public let deliveryFeesCents: Int
  public let deliveriesCount: Int
  public let totalCents: Int

  public init(
    period: String,
    since: String,
    until: String,
    tipsCents: Int,
    deliveryFeesCents: Int,
    deliveriesCount: Int,
    totalCents: Int
  ) {
    self.period = period
    self.since = since
    self.until = until
    self.tipsCents = tipsCents
    self.deliveryFeesCents = deliveryFeesCents
    self.deliveriesCount = deliveriesCount
    self.totalCents = totalCents
  }
}

public extension EarningsResponseDTO {
  /// Returns nil when the period tag is unknown or the bound
  /// timestamps fail to parse. The half-open window
  /// `[since, until)` is the server's framing — the iOS reducer
  /// renders the window as "Today (May 19)" by formatting `since`
  /// against America/Chicago.
  func toDomain() -> DriverEarnings? {
    guard let parsedPeriod = EarningsPeriod(rawValue: period) else { return nil }
    guard let parsedSince = CatalogWire.parseISO8601(since) else { return nil }
    guard let parsedUntil = CatalogWire.parseISO8601(until) else { return nil }
    return DriverEarnings(
      period: parsedPeriod,
      since: parsedSince,
      until: parsedUntil,
      tipsCents: tipsCents,
      deliveryFeesCents: deliveryFeesCents,
      deliveriesCount: deliveriesCount,
      totalCents: totalCents
    )
  }
}

/// Wire shape of `GET /v1/driver/shifts`. Flat array; backend caps at
/// 50 rows so no cursor here — recent-history surface, not analytics.
public struct ShiftsListResponseDTO: Decodable, Sendable, Equatable {
  public let shifts: [DriverShiftResponseDTO]

  public init(shifts: [DriverShiftResponseDTO]) {
    self.shifts = shifts
  }
}

public extension ShiftsListResponseDTO {
  /// One malformed shift row should not black-hole the history view;
  /// drop bad rows silently and surface the rest.
  func toDomain() -> [DriverShift] {
    shifts.compactMap { $0.toDomain() }
  }
}
