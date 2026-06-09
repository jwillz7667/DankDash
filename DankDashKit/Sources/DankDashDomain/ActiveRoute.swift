import Foundation

/// The driver's working bundle for one in-progress delivery. Mirror of
/// the `DriverOrderDetailResponseSchema` shape returned by
/// `GET /v1/driver/orders/:id` — a single denormalized projection that
/// the route screen renders without follow-up calls.
///
/// The driver projection deliberately diverges from the consumer's
/// `OrderDetailResponse`:
///
///   - `dropoff` is INLINE (the driver is navigating to it; we don't
///     want to round-trip a saved-address fetch).
///   - `customer.firstName` / `customer.lastName` are split so the UI
///     can render "Sam J." instead of leaking the full surname.
///   - `idScan` is the gate state (passed yet? which verification?).
///   - `customer.maskedPhone` routes through Twilio Proxy in a later
///     phase so the driver never sees the consumer's raw number.
///
/// `events` is server-sorted ASC by `occurredAt`. The driver UI keys off
/// `order.status` to decide which leg of the route to render
/// (`enRoutePickup` → toPickup, `pickedUp`/`enRouteDropoff` → toDropoff,
/// `arrivedAtDropoff`/`idScanPending` → at dropoff awaiting handoff).
public struct ActiveRoute: Sendable, Equatable, Identifiable {
  public var order: Order
  public var customer: DriverHandoffCustomer
  public var dispensary: DriverHandoffDispensary
  public var dropoff: DriverHandoffAddress
  public var idScan: DeliveryHandoff
  public var events: [OrderEvent]

  public var id: UUID { order.id }

  public init(
    order: Order,
    customer: DriverHandoffCustomer,
    dispensary: DriverHandoffDispensary,
    dropoff: DriverHandoffAddress,
    idScan: DeliveryHandoff,
    events: [OrderEvent]
  ) {
    self.order = order
    self.customer = customer
    self.dispensary = dispensary
    self.dropoff = dropoff
    self.idScan = idScan
    self.events = events
  }

  /// Which navigation leg the driver should be on, derived from the
  /// authoritative `order.status`. Anything outside the active-route
  /// happy-path returns `nil` — the parent should route to a different
  /// screen (delivered → wallet, terminal failure → support).
  public var currentLeg: RouteLeg? {
    switch order.status {
    case .driverAssigned, .enRoutePickup:
      return .toPickup
    case .pickedUp, .enRouteDropoff:
      return .toDropoff
    case .arrivedAtDropoff, .idScanPending, .idScanPassed:
      return .atDropoff
    case .delivered:
      return .completed
    case .idScanFailed,
         .returnedToStore,
         .canceled,
         .disputed,
         .rejected,
         .paymentFailed,
         .placed,
         .accepted,
         .prepping,
         .readyForPickup,
         .awaitingDriver,
         .dispatchFailed:
      return nil
    }
  }
}
