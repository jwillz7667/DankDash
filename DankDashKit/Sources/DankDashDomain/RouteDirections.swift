import Foundation

/// Directions for one route segment as computed by the iOS MapKit
/// directions API. The reducer requests these for the dispensary leg
/// the moment the driver accepts an offer, and again for the dropoff
/// leg the moment they confirm pickup. The polyline drives the
/// `MKPolyline` overlay on the map; `expectedTravelTimeSeconds` and
/// `distanceMeters` feed the ETA chip.
///
/// `steps` is the ordered list of turn-by-turn instructions; the
/// reducer picks the "current" step by comparing the driver's live
/// coordinate against each step's polyline. We deliberately keep the
/// types pure-Swift (no `MKRoute` leak) so unit tests can fixture this
/// without spinning up MapKit.
public struct RouteDirections: Sendable, Equatable, Hashable {
  public let polyline: [Coordinate]
  public let steps: [RouteStep]
  public let expectedTravelTimeSeconds: TimeInterval
  public let distanceMeters: Double

  public init(
    polyline: [Coordinate],
    steps: [RouteStep],
    expectedTravelTimeSeconds: TimeInterval,
    distanceMeters: Double
  ) {
    self.polyline = polyline
    self.steps = steps
    self.expectedTravelTimeSeconds = expectedTravelTimeSeconds
    self.distanceMeters = distanceMeters
  }
}

/// One turn-by-turn step. `instruction` is the natural-language
/// imperative (e.g., "Turn right on Hennepin Ave S"); `polyline` is the
/// sub-arc this step covers — the reducer projects the live coordinate
/// against it to decide when to advance to the next step.
public struct RouteStep: Sendable, Equatable, Hashable, Identifiable {
  public let id: Int
  public let instruction: String
  public let notice: String?
  public let distanceMeters: Double
  public let polyline: [Coordinate]

  public init(
    id: Int,
    instruction: String,
    notice: String?,
    distanceMeters: Double,
    polyline: [Coordinate]
  ) {
    self.id = id
    self.instruction = instruction
    self.notice = notice
    self.distanceMeters = distanceMeters
    self.polyline = polyline
  }
}

/// Which transport mode MapKit should compute the route for. The
/// driver app only ever uses `.automobile` today; `.walking` is here
/// as the cheap forward-compat for a future "park-and-walk" handoff
/// segment on dense urban deliveries.
public enum RouteTransportType: Sendable, Equatable, Hashable {
  case automobile
  case walking
}
