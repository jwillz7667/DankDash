import Foundation

/// What the Veriff SDK reports back to the host app via its terminal
/// callbacks. Lives in `DankDashDomain` so the reducer can take it as a
/// pure value and tests can synthesize each variant without linking
/// the SDK itself (Veriff is iOS-only; tests run on macOS).
///
/// `.completed` means the SDK finished uploading the documents — NOT
/// that Veriff approved the driver. The reducer follows up with a
/// backend submit-result POST that queries Veriff for the authoritative
/// decision (the SDK callback alone is not trustworthy — see
/// `apps/api/.../driver-id-scan.service.ts`).
public enum IDScanSDKOutcome: Sendable, Equatable, Hashable {
  case completed
  case canceled
  case error(reason: String)
}
