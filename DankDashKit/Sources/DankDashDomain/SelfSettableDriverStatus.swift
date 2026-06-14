import Foundation

/// The three statuses a driver can self-set via `POST /v1/driver/status`.
/// Mirrors `SelfSettableDriverStatusSchema` in
/// `apps/api/.../drivers/shift/dto/shift.dto.ts`.
///
/// `offline` is explicitly excluded — ending availability also ends the
/// shift, and the shift row needs a closing location which the status
/// endpoint does not carry. Drivers go offline via
/// `POST /v1/driver/shift/end` only.
///
/// `enRoutePickup` / `enRouteDropoff` are machine-driven (set by the
/// offer-accept handler and the pickup-confirm handler respectively);
/// a self-set would create a phantom assignment.
public enum SelfSettableDriverStatus: String, Hashable, Sendable, CaseIterable, Codable {
  case online
  case onBreak = "on_break"
  case unavailable

  /// User-facing menu label.
  public var displayLabel: String {
    switch self {
    case .online: "Online"
    case .onBreak: "On break"
    case .unavailable: "Unavailable"
    }
  }

  /// Projection back to the full ``DriverStatus``. Always succeeds
  /// because every case has a 1:1 mapping.
  public var asDriverStatus: DriverStatus {
    switch self {
    case .online: .online
    case .onBreak: .onBreak
    case .unavailable: .unavailable
    }
  }
}

public extension DriverStatus {
  /// The self-settable projection of this status, or `nil` for the
  /// machine-driven (`enRoutePickup` / `enRouteDropoff`) and terminal
  /// (`offline`) cases a driver can't set via `POST /v1/driver/status`.
  ///
  /// Used by the shift heartbeat to *re-assert the current availability*
  /// rather than force a value the driver didn't choose — forcing
  /// `.online` on every tick silently un-paused an `on_break` /
  /// `unavailable` driver.
  var asSelfSettable: SelfSettableDriverStatus? {
    switch self {
    case .online: .online
    case .onBreak: .onBreak
    case .unavailable: .unavailable
    case .enRoutePickup, .enRouteDropoff, .offline: nil
    }
  }
}
