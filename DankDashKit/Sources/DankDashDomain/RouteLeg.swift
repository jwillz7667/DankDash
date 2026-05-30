import Foundation

/// Which segment of an active delivery route the driver is on.
/// The reducer flips through these in lockstep with `order.status`
/// — driver-driven taps (`Confirm Pickup`, `Arrived`) round-trip the
/// server and only mutate the leg AFTER the status transition lands
/// (so a server-side validation failure can never leave the iOS UI
/// out of sync with the canonical state).
public enum RouteLeg: Sendable, Equatable {
  /// Driving from current position to the dispensary.
  case toPickup
  /// Driving from the dispensary to the customer's drop.
  case toDropoff
  /// Parked at the drop, working through the ID-scan handoff.
  case atDropoff
  /// Hand-off completed — the screen is about to push to the wallet.
  case completed
}
