import XCTest
@testable import DankDashDomain

/// Coverage for the Veriff terminal-status → ``IDScanSDKOutcome``
/// mapping. This is the pure half of the driver ID-scan seam: the
/// DankDasher app target translates the iOS-only `VeriffSdk.Status`
/// binary enum into ``VeriffSessionOutcome`` with a trivial case map,
/// then hands it here. Keeping the decision + copy in the domain layer
/// lets the macOS test host cover every branch without linking the SDK.
final class VeriffSessionOutcomeTests: XCTestCase {

  // MARK: - Status → outcome contract

  func test_done_mapsToCompleted() {
    XCTAssertEqual(IDScanSDKOutcome(veriffOutcome: .done), .completed)
  }

  func test_canceled_mapsToCanceled() {
    XCTAssertEqual(IDScanSDKOutcome(veriffOutcome: .canceled), .canceled)
  }

  func test_everyError_mapsToErrorOutcome() {
    for error in Self.allErrors {
      guard case .error(let reason) = IDScanSDKOutcome(veriffOutcome: .error(error)) else {
        XCTFail("\(error) did not map to an .error outcome")
        continue
      }
      XCTAssertEqual(reason, error.userFacingReason)
    }
  }

  // MARK: - Reason copy invariants

  func test_everyReason_isNonEmptyAndHasNoTrailingPeriod() {
    // The launch view renders "\(reason). N attempts remaining." — a
    // trailing period would double up, an empty reason would read as a
    // stray sentence.
    for error in Self.allErrors {
      let reason = error.userFacingReason
      XCTAssertFalse(reason.isEmpty, "\(error) reason is empty")
      XCTAssertFalse(reason.hasSuffix("."), "\(error) reason ends with a period: \(reason)")
    }
  }

  func test_permissionErrors_pointUserToSettings() {
    XCTAssertTrue(VeriffSDKError.cameraUnavailable.userFacingReason.contains("Settings"))
    XCTAssertTrue(VeriffSDKError.microphoneUnavailable.userFacingReason.contains("Settings"))
  }

  func test_deprecatedSDK_promptsAppUpdate() {
    XCTAssertTrue(
      VeriffSDKError.deprecatedSDKVersion.userFacingReason.localizedCaseInsensitiveContains("update")
    )
  }

  // MARK: - Fixtures

  /// Every `VeriffSDKError` case. A new SDK error added to the mirror
  /// enum without a `userFacingReason` branch fails to compile in the
  /// domain source; adding it here keeps the invariants above honest.
  private static let allErrors: [VeriffSDKError] = [
    .cameraUnavailable,
    .microphoneUnavailable,
    .serverError,
    .localError,
    .networkError,
    .uploadError,
    .videoFailed,
    .deprecatedSDKVersion,
    .unknown,
    .deviceHasNoNFC,
    .documentHasNoNFC,
    .nfcScanError,
    .uploadLimitReached,
  ]
}
