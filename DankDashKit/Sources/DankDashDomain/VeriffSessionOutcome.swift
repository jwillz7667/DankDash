import Foundation

/// Veriff-independent projection of the iOS SDK's terminal session
/// status. The DankDasher app target translates the SDK's `VeriffSdk.Status`
/// (which links only on iOS — the SDK is a binary xcframework) into this
/// value type so the status → ``IDScanSDKOutcome`` mapping, and the
/// user-facing copy that rides on it, stay pure functions the macOS
/// `swift test` host can cover without the SDK binary.
///
/// This mirrors `VeriffSdk.Status`: `.done` (documents submitted),
/// `.canceled` (end-user dismissed the flow), `.error` (the flow could
/// not complete). It carries no verification *decision* — the SDK never
/// reports approve/decline; the backend fetches the authoritative
/// decision on the submit-result POST.
public enum VeriffSessionOutcome: Sendable, Equatable, Hashable {
  case done
  case canceled
  case error(VeriffSDKError)
}

/// 1:1 mirror of `VeriffSdk.Error` (Veriff iOS SDK 10.x). Kept aligned
/// with the SDK enum so the app-target adapter is a trivial case
/// translation and this file — where the driver-facing copy lives —
/// carries the whole mapping under test.
public enum VeriffSDKError: Sendable, Equatable, Hashable {
  case cameraUnavailable
  case microphoneUnavailable
  case serverError
  case localError
  case networkError
  case uploadError
  case videoFailed
  case deprecatedSDKVersion
  case unknown
  case deviceHasNoNFC
  case documentHasNoNFC
  case nfcScanError
  case uploadLimitReached
}

public extension IDScanSDKOutcome {
  /// Collapses a Veriff terminal status onto the reducer's SDK-outcome
  /// contract. `.done` becomes `.completed` (documents uploaded — NOT an
  /// approval); `.canceled` stays a user dismissal the reducer must not
  /// charge against the retry budget; every `.error` carries a short,
  /// period-free reason ``IDScanLaunchView`` splices into its
  /// "N attempts remaining" line.
  init(veriffOutcome outcome: VeriffSessionOutcome) {
    switch outcome {
    case .done:
      self = .completed
    case .canceled:
      self = .canceled
    case .error(let error):
      self = .error(reason: error.userFacingReason)
    }
  }
}

public extension VeriffSDKError {
  /// Short, sentence-fragment copy with no trailing period — the launch
  /// view appends the attempts-remaining clause. Distinguishes the cases
  /// a driver can act on (grant camera/mic in Settings, update the app)
  /// from transient ones a re-scan may clear.
  var userFacingReason: String {
    switch self {
    case .cameraUnavailable:
      "Camera access is off — turn it on in Settings to scan"
    case .microphoneUnavailable:
      "Microphone access is off — turn it on in Settings to scan"
    case .networkError:
      "The connection dropped during the scan"
    case .serverError:
      "The verification service hit a problem"
    case .uploadError:
      "The scan didn't finish uploading"
    case .uploadLimitReached:
      "Too many attempts on this session — start a fresh scan"
    case .videoFailed:
      "The scan didn't record — try again in better lighting"
    case .deprecatedSDKVersion:
      "Update DankDasher to verify IDs"
    case .deviceHasNoNFC, .documentHasNoNFC, .nfcScanError:
      "Couldn't read the ID's chip"
    case .localError, .unknown:
      "The scan couldn't be completed"
    }
  }
}
