import Foundation
import DankDashDomain

/// Response payload for `POST /v1/driver/orders/:id/id-scan-session`.
/// Mirror of the backend `DriverIdScanSessionResponseSchema` —
/// `verificationId` is the Veriff handle, `sessionToken` is what the
/// SDK consumes, `sessionUrl` is the hosted-flow web URL (Safari
/// fallback when the SDK can't launch — e.g. older OS versions or
/// transient SDK init failures).
public struct DriverIDScanSessionResponseDTO: Decodable, Sendable, Equatable {
  public let verificationId: String
  public let sessionUrl: String
  public let sessionToken: String

  public init(verificationId: String, sessionUrl: String, sessionToken: String) {
    self.verificationId = verificationId
    self.sessionUrl = sessionUrl
    self.sessionToken = sessionToken
  }

  /// Lossy projection. A malformed `sessionUrl` short-circuits to nil
  /// because the iOS Safari-fallback path needs a parseable URL — if
  /// the SDK happy path is the only one wired, the URL is still the
  /// piece a UIActivity / browser handoff would consume.
  public func toDomain() -> IDScanSession? {
    guard let parsedURL = URL(string: sessionUrl) else { return nil }
    return IDScanSession(
      verificationId: verificationId,
      sessionUrl: parsedURL,
      sessionToken: sessionToken,
      expiresAt: nil
    )
  }
}

/// Request body for `POST /v1/driver/orders/:id/id-scan-result`. The
/// backend schema is `.strict()` (no extra keys) and `verificationId`
/// is bounded to 1…64 chars — we don't trim/cap here because the
/// reducer hands us exactly what the SDK reported, and a malformed
/// value should surface as a 400 from the backend rather than be
/// silently rewritten.
public struct DriverIDScanResultRequestDTO: Encodable, Sendable, Equatable {
  public let verificationId: String

  public init(verificationId: String) {
    self.verificationId = verificationId
  }
}
