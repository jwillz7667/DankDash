import Foundation
import DankDashDomain

/// Body for `POST /v1/driver/status`. Wire shape:
/// `{ status: "online" | "on_break" | "unavailable" }`. The backend's
/// `UpdateDriverStatusRequestSchema` excludes `offline` (use shift/end)
/// and `en_route_*` (machine-driven by the order state machine), so
/// the body is typed against `SelfSettableDriverStatus` rather than
/// the full `DriverStatus` enum.
public struct UpdateDriverStatusRequestDTO: Encodable, Sendable, Equatable {
  public let status: String

  public init(status: SelfSettableDriverStatus) {
    self.status = status.rawValue
  }
}
