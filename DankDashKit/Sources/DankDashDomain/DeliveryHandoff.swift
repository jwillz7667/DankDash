import Foundation

/// The ID-scan handoff gate on one order. Mirror of the
/// `delivery_id_scan_*` columns on `orders` (passed flag,
/// `delivery_verification_id`, `delivery_id_scan_at`).
///
/// The driver app reads this every time it lands on the route screen
/// — `passed = true` flips the Delivery Complete CTA from "Scan ID"
/// to "Mark Delivered" and gates the `delivery_confirm` POST through
/// to the server (the server enforces the gate inside `transitionStatus`,
/// so iOS is a soft UX gate on top of the hard server gate).
///
/// `verificationId` is the Veriff handle persisted on the order row
/// the first time the iOS app starts a session. On re-launch, the
/// reducer uses this to RESUME an in-progress session rather than
/// pay for a fresh Veriff verification.
public struct DeliveryHandoff: Sendable, Equatable, Hashable, Codable {
  public let orderId: UUID
  public let passed: Bool
  public let verificationId: String?
  public let scannedAt: Date?

  public init(
    orderId: UUID,
    passed: Bool,
    verificationId: String?,
    scannedAt: Date?
  ) {
    self.orderId = orderId
    self.passed = passed
    self.verificationId = verificationId
    self.scannedAt = scannedAt
  }
}
