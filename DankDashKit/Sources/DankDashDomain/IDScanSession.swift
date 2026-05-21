import Foundation

/// The session payload returned by `POST /v1/driver/orders/:id/id-scan-session`.
/// The driver app feeds `sessionToken` to the Veriff iOS SDK to launch
/// the flow; `sessionUrl` is the hosted-flow URL (useful as a Safari
/// fallback when the SDK link fails to load), and `verificationId` is
/// the handle iOS reports back on `POST .../id-scan-result` so the
/// backend can cross-check against the order's stored session.
///
/// `expiresAt` is intentionally optional — the backend currently does
/// not return a wire-level expiry (Veriff sessions are valid for ~24h
/// and we recreate them per-order anyway), but the reducer reserves the
/// slot so an iOS-side "session got stale, recreate" branch can light
/// without a wire-shape revision.
public struct IDScanSession: Sendable, Equatable, Hashable {
  public let verificationId: String
  public let sessionUrl: URL
  public let sessionToken: String
  public let expiresAt: Date?

  public init(
    verificationId: String,
    sessionUrl: URL,
    sessionToken: String,
    expiresAt: Date? = nil
  ) {
    self.verificationId = verificationId
    self.sessionUrl = sessionUrl
    self.sessionToken = sessionToken
    self.expiresAt = expiresAt
  }
}
