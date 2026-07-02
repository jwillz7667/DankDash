import Foundation
import UIKit
import Veriff
import DankDashDomain
import DankDashFeatures

/// Live binding of ``IdentityVerificationClient`` over the Veriff iOS
/// SDK (`import Veriff`, SPM product "Veriff"). Wired at boot in
/// `AppEnvironment.prepareDependencies` — DankDashKit ships only the
/// placeholder `.live` because the SDK is an iOS-only binary xcframework
/// that does not link on the macOS `swift test` host.
///
/// The seam is one shot per session: present the Veriff flow from the
/// top view controller, await the SDK's terminal delegate callback,
/// translate it into ``VeriffSessionOutcome`` and then the reducer's
/// ``IDScanSDKOutcome``. The Veriff → domain translation is a trivial
/// 1:1 case map; the decision logic and the user-facing copy live in
/// ``DankDashDomain`` where they are unit-tested.
extension IdentityVerificationClient {
  static var veriff: IdentityVerificationClient {
    IdentityVerificationClient(
      launchSDK: { session in
        let outcome = await VeriffSessionRunner.run(sessionURL: session.sessionUrl.absoluteString)
        return IDScanSDKOutcome(veriffOutcome: outcome)
      }
    )
  }
}

/// Presents the Veriff flow on the main actor and resolves the terminal
/// outcome. Isolated to the main actor because it drives UIKit
/// presentation; the caller is the reducer's `.run` effect, which hops
/// here via `await`.
@MainActor
private enum VeriffSessionRunner {
  static func run(sessionURL: String) async -> VeriffSessionOutcome {
    guard let presenter = topViewController() else {
      // No foreground view controller to present from — treat as a
      // recoverable local error so the reducer surfaces "try again"
      // rather than hanging in `.sdkInProgress` forever.
      return .error(.localError)
    }
    let coordinator = VeriffSessionCoordinator()
    return await coordinator.start(sessionURL: sessionURL, presentingFrom: presenter)
  }

  /// Topmost presented view controller of the key window. Veriff pushes
  /// its own full-screen flow onto whatever we hand it.
  private static func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
    guard let window = scene?.windows.first(where: \.isKeyWindow) ?? scene?.windows.first else {
      return nil
    }
    var top = window.rootViewController
    while let presented = top?.presentedViewController {
      top = presented
    }
    return top
  }
}

/// Bridges the Veriff SDK's delegate callback to an `async` result.
/// The SDK holds `delegate` weakly and calls back once when the flow
/// ends; the awaiting `start(...)` frame keeps this instance alive for
/// the duration.
@MainActor
private final class VeriffSessionCoordinator: NSObject {
  private var continuation: CheckedContinuation<VeriffSessionOutcome, Never>?

  func start(
    sessionURL: String,
    presentingFrom presenter: UIViewController
  ) async -> VeriffSessionOutcome {
    await withCheckedContinuation { continuation in
      self.continuation = continuation
      let sdk = VeriffSdk.shared
      sdk.delegate = self
      sdk.startAuthentication(sessionUrl: sessionURL, presentingFrom: presenter)
    }
  }

  private func complete(with outcome: VeriffSessionOutcome) {
    guard let continuation else { return }
    self.continuation = nil
    if VeriffSdk.shared.delegate === self {
      VeriffSdk.shared.delegate = nil
    }
    continuation.resume(returning: outcome)
  }
}

extension VeriffSessionCoordinator: VeriffSdkDelegate {
  // `VeriffSdkDelegate` is a nonisolated `@objc` protocol. The SDK
  // invokes it on the main thread once the flow is dismissed; we mark
  // it `nonisolated` to satisfy the requirement without an isolation
  // warning, translate the (immutable) result inline, then hop to the
  // main actor to resume the continuation.
  nonisolated func sessionDidEndWithResult(_ result: VeriffSdk.Result) {
    let outcome = VeriffSessionOutcome(result.status)
    Task { @MainActor in self.complete(with: outcome) }
  }

  // NFC is not part of the driver ID-scan flow — no-op the required
  // delegate methods.
  nonisolated func nfcDataExtracted(_ data: VeriffSdk.NFCData) {}
  nonisolated func nfcDataExtractionFailed() {}
}

// MARK: - Veriff SDK → domain translation

private extension VeriffSessionOutcome {
  nonisolated init(_ status: VeriffSdk.Status) {
    switch status {
    case .done:
      self = .done
    case .canceled:
      self = .canceled
    case .error(let error):
      self = .error(VeriffSDKError(error))
    @unknown default:
      self = .error(.unknown)
    }
  }
}

private extension VeriffSDKError {
  nonisolated init(_ error: VeriffSdk.Error) {
    switch error {
    case .cameraUnavailable: self = .cameraUnavailable
    case .microphoneUnavailable: self = .microphoneUnavailable
    case .serverError: self = .serverError
    case .localError: self = .localError
    case .networkError: self = .networkError
    case .uploadError: self = .uploadError
    case .videoFailed: self = .videoFailed
    case .deprecatedSDKVersion: self = .deprecatedSDKVersion
    case .unknown: self = .unknown
    case .deviceHasNoNFC: self = .deviceHasNoNFC
    case .documentHasNoNFC: self = .documentHasNoNFC
    case .nfcScanError: self = .nfcScanError
    case .uploadLimitReached: self = .uploadLimitReached
    @unknown default: self = .unknown
    }
  }
}
