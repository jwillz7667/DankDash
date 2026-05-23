import Foundation

/// The six driver dispatch states the backend recognizes. Mirrors the
/// `DriverStatusSchema` enum in `apps/api/.../drivers/dto/driver.dto.ts`.
///
/// - `offline` — shift is closed. Driver cannot receive offers. Set by
///   `POST /v1/driver/shift/end`, never self-set via status update.
/// - `online` — accepting offers. The default during an active shift.
/// - `enRoutePickup` — accepted an offer and driving to the dispensary.
///   Machine-driven by the offer-accept handler; never self-set.
/// - `enRouteDropoff` — picked up the order and driving to the customer.
///   Machine-driven by the pickup-confirm handler.
/// - `onBreak` — temporary unavailability (eating, restroom). Self-set,
///   recoverable to `online`.
/// - `unavailable` — soft unavailability (low battery, family call).
///   Self-set, recoverable to `online`.
///
/// Only `online`, `onBreak`, and `unavailable` are self-settable via
/// `POST /v1/driver/status`. See ``SelfSettableDriverStatus`` for the
/// narrowed enum the request body validates against.
public enum DriverStatus: String, Hashable, Sendable, CaseIterable, Codable {
  case offline
  case online
  case enRoutePickup = "en_route_pickup"
  case enRouteDropoff = "en_route_dropoff"
  case onBreak = "on_break"
  case unavailable

  /// User-facing label for the status pill in the driver app's shift
  /// surface.
  public var displayLabel: String {
    switch self {
    case .offline: "Offline"
    case .online: "Online"
    case .enRoutePickup: "Heading to pickup"
    case .enRouteDropoff: "On delivery"
    case .onBreak: "On break"
    case .unavailable: "Unavailable"
    }
  }

  /// True when the driver is in any state that admits new dispatch
  /// offers. Only `online` qualifies — break/unavailable explicitly
  /// remove the driver from the offer pool until they flip back.
  public var isAvailableForOffers: Bool {
    self == .online
  }

  /// True when the driver is currently engaged with an order
  /// (machine-driven by the order state machine). The shift toggle
  /// disables itself during these states so a driver can't accidentally
  /// end a shift mid-delivery.
  public var isOnActiveDelivery: Bool {
    self == .enRoutePickup || self == .enRouteDropoff
  }
}
