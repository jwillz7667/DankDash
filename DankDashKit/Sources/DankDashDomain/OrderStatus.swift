import Foundation

/// The 20-state order lifecycle. Mirrors the `order_status` enum in
/// `packages/db/src/schema/enums.ts` — adding a state requires a
/// coordinated server + iOS release. Server is authoritative on every
/// transition; iOS only receives them via order detail re-fetches or
/// the realtime `order:status_changed` event.
///
/// States split into:
///
/// - **Happy delivery path** (12 states): `placed` → `accepted` →
///   `prepping` → `awaitingDriver` → `driverAssigned` →
///   `enRoutePickup` → `pickedUp` → `enRouteDropoff` →
///   `arrivedAtDropoff` → `idScanPending` → `idScanPassed` →
///   `delivered`.
/// - **Pickup-only leaf**: `readyForPickup` (not used in delivery-only
///   consumer scope; present for enum completeness so the API does not
///   need a separate type for pickup-capable surfaces).
/// - **Terminal failures** (7 states): `paymentFailed`, `rejected`,
///   `dispatchFailed`, `canceled`, `idScanFailed`, `returnedToStore`,
///   `disputed`. `dispatchFailed` is reached from `awaitingDriver` when
///   no driver can be assigned within the dispatch budget — it is a
///   terminal state the order cannot leave (mirrors the XState machine's
///   `dispatch_failed` final state).
public enum OrderStatus: String, Hashable, Sendable, CaseIterable, Codable {
  case placed
  case paymentFailed = "payment_failed"
  case accepted
  case rejected
  case prepping
  case readyForPickup = "ready_for_pickup"
  case awaitingDriver = "awaiting_driver"
  case dispatchFailed = "dispatch_failed"
  case driverAssigned = "driver_assigned"
  case enRoutePickup = "en_route_pickup"
  case pickedUp = "picked_up"
  case enRouteDropoff = "en_route_dropoff"
  case arrivedAtDropoff = "arrived_at_dropoff"
  case idScanPending = "id_scan_pending"
  case idScanPassed = "id_scan_passed"
  case idScanFailed = "id_scan_failed"
  case delivered
  case returnedToStore = "returned_to_store"
  case canceled
  case disputed

  /// Monotone non-decreasing index across the happy-path sequence —
  /// `OrderStatusTimeline` uses this to decide which milestones to
  /// mark complete. Terminal failure states sit in a sentinel band
  /// (100+) so they never compare less than a happy-path state.
  /// `readyForPickup` slots between `prepping` and `awaitingDriver` —
  /// it is a pickup-flow leaf and a delivery order never reaches it,
  /// but assigning it a slot keeps the ordering well-defined for any
  /// future surface that ingests it.
  public var canonicalOrder: Int {
    switch self {
    case .placed: return 0
    case .accepted: return 1
    case .prepping: return 2
    case .readyForPickup: return 3
    case .awaitingDriver: return 4
    case .driverAssigned: return 5
    case .enRoutePickup: return 6
    case .pickedUp: return 7
    case .enRouteDropoff: return 8
    case .arrivedAtDropoff: return 9
    case .idScanPending: return 10
    case .idScanPassed: return 11
    case .delivered: return 12
    case .paymentFailed: return 100
    case .rejected: return 101
    case .canceled: return 102
    case .idScanFailed: return 103
    case .returnedToStore: return 104
    case .disputed: return 105
    case .dispatchFailed: return 106
    }
  }

  /// True for states the order cannot transition out of. `delivered`
  /// is the only successful terminal; the rest are failure terminals
  /// — `paymentFailed`, `rejected`, `dispatchFailed`, `canceled`,
  /// `idScanFailed`, `returnedToStore`, `disputed`. Tracking-screen
  /// polling stops once `isTerminal` is true.
  public var isTerminal: Bool {
    switch self {
    case .delivered,
         .paymentFailed,
         .rejected,
         .dispatchFailed,
         .canceled,
         .idScanFailed,
         .returnedToStore,
         .disputed:
      return true
    case .placed,
         .accepted,
         .prepping,
         .readyForPickup,
         .awaitingDriver,
         .driverAssigned,
         .enRoutePickup,
         .pickedUp,
         .enRouteDropoff,
         .arrivedAtDropoff,
         .idScanPending,
         .idScanPassed:
      return false
    }
  }

  /// Plain user-facing label for the status pill in the order-detail
  /// header. The Orders timeline UI groups several of these into named
  /// stages ("Preparing", "On the way", "Arriving") — this label is
  /// what appears next to the pill, not the timeline stage caption.
  public var displayLabel: String {
    switch self {
    case .placed: return "Placed"
    case .paymentFailed: return "Payment failed"
    case .accepted: return "Accepted"
    case .rejected: return "Rejected"
    case .prepping: return "Preparing"
    case .readyForPickup: return "Ready for pickup"
    case .awaitingDriver: return "Ready for pickup"
    case .dispatchFailed: return "No driver available"
    case .driverAssigned: return "Driver assigned"
    case .enRoutePickup: return "Driver heading to store"
    case .pickedUp: return "Picked up"
    case .enRouteDropoff: return "On the way"
    case .arrivedAtDropoff: return "Arriving"
    case .idScanPending: return "ID check"
    case .idScanPassed: return "ID verified"
    case .idScanFailed: return "ID check failed"
    case .delivered: return "Delivered"
    case .returnedToStore: return "Returned to store"
    case .canceled: return "Canceled"
    case .disputed: return "Disputed"
    }
  }
}
