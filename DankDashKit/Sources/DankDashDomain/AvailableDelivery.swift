import Foundation

/// One claimable delivery on the open dasher pool — an order sitting in
/// `awaiting_driver` whose dispensary is within the dispatch radius of
/// the driver asking. Carries everything the map needs to draw the
/// pickup pin, the floating tip, and (on tap) the dispensary → drop-off
/// route, without a second round-trip.
///
/// This is the open-pool analogue of ``DispatchOffer``: a `DispatchOffer`
/// is a targeted, time-boxed offer to ONE driver; an `AvailableDelivery`
/// is an untargeted, first-come-claim item every eligible driver sees.
public struct AvailableDelivery: Identifiable, Hashable, Sendable, Codable {
  public let orderId: UUID
  public let shortCode: String
  public let dispensaryId: UUID
  public let pickupName: String
  public let pickup: Coordinate
  public let dropoff: Coordinate
  /// Driver tip in cents. The headline number on the pin — what the
  /// driver earns on top of the delivery fee.
  public let tipCents: Int
  public let totalCents: Int
  /// Beeline meters from the driver's current location to the pickup —
  /// used to sort nearest-first and render "X mi away".
  public let distanceMeters: Double
  public let awaitingDriverAt: Date?

  public var id: UUID { orderId }

  public init(
    orderId: UUID,
    shortCode: String,
    dispensaryId: UUID,
    pickupName: String,
    pickup: Coordinate,
    dropoff: Coordinate,
    tipCents: Int,
    totalCents: Int,
    distanceMeters: Double,
    awaitingDriverAt: Date?
  ) {
    self.orderId = orderId
    self.shortCode = shortCode
    self.dispensaryId = dispensaryId
    self.pickupName = pickupName
    self.pickup = pickup
    self.dropoff = dropoff
    self.tipCents = tipCents
    self.totalCents = totalCents
    self.distanceMeters = distanceMeters
    self.awaitingDriverAt = awaitingDriverAt
  }

  /// Tip rendered as dollars for the pin badge / detail sheet.
  public var tipDollars: Decimal {
    Decimal(tipCents) / 100
  }

  /// Beeline distance to the pickup in miles (1 mi = 1609.344 m).
  public var distanceMiles: Double {
    distanceMeters / 1609.344
  }
}
