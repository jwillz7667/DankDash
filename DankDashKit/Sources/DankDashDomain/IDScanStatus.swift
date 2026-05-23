import Foundation

/// State machine for the ID-scan handoff screen. Tracks the driver's
/// position through the Veriff flow — each transition is driven by
/// either a user tap, an SDK callback, or a backend response.
///
///   `.notStarted` ─Begin Scan→ `.sessionRequested`
///   `.sessionRequested` ─session OK→ `.sdkInProgress`
///   `.sessionRequested` ─session fails→ `.failed(reason)`
///   `.sdkInProgress` ─SDK .completed→ `.awaitingResult`
///   `.sdkInProgress` ─SDK .canceled→ `.notStarted`
///   `.sdkInProgress` ─SDK .error→ `.failed(reason)`
///   `.awaitingResult` ─submit-result passed→ `.passed`
///   `.awaitingResult` ─submit-result failed→ `.failed(reason)`
///
/// `.passed` is a terminal success; the reducer emits the delegate the
/// instant it lands. `.failed(reason)` is recoverable up to a retry
/// budget — after the third failure the UI surfaces escalation CTAs
/// rather than another Re-Scan.
public enum IDScanStatus: Sendable, Equatable, Hashable {
  case notStarted
  case sessionRequested
  case sdkInProgress
  case awaitingResult
  case passed
  case failed(reason: String)

  public var isTerminal: Bool {
    switch self {
    case .passed, .failed: true
    default: false
    }
  }

  public var isInFlight: Bool {
    switch self {
    case .sessionRequested, .sdkInProgress, .awaitingResult: true
    default: false
    }
  }
}
