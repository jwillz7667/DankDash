import Foundation
import ComposableArchitecture
import DankDashDomain

/// SDK seam over the Veriff iOS SDK. The package binds a placeholder
/// `.live` because Veriff is iOS-only (the SDK does not link on macOS,
/// where `swift test` runs) — the DankDasher app target overrides this
/// dependency at boot with the real Veriff launch closure.
///
/// `launchSDK(_:)` is one shot per session: it presents the Veriff
/// flow, awaits a terminal callback (`done` / `canceled` / `error`),
/// maps it to ``IDScanSDKOutcome``, and returns. The reducer never
/// races multiple launches against the same session — the cancel id
/// on the calling effect serializes retries.
///
/// **Why the seam doesn't include `pollResult`:** the backend's
/// `POST /v1/driver/orders/:id/id-scan-result` already chains the
/// authoritative Veriff decision fetch on the server, so iOS just
/// submits once. If the response still reports `idScan.passed == false`
/// with no `scannedAt` (Veriff returned "pending"), the reducer is the
/// thing that retries — not this client.
public struct IdentityVerificationClient: Sendable {
  public var launchSDK: @Sendable (IDScanSession) async -> IDScanSDKOutcome

  public init(
    launchSDK: @Sendable @escaping (IDScanSession) async -> IDScanSDKOutcome
  ) {
    self.launchSDK = launchSDK
  }
}

public extension IdentityVerificationClient {
  /// Package-level placeholder. The actual Veriff binding lives at the
  /// `DankDasher` app target — boot wires the dependency override so
  /// the reducer sees a real SDK seam. On the macOS test host this
  /// path is unreachable because every test overrides the dependency.
  static let live = IdentityVerificationClient(
    launchSDK: { _ in
      .error(reason: "IdentityVerificationClient.live not wired — override at app boot.")
    }
  )

  static let unimplemented = IdentityVerificationClient(
    launchSDK: { _ in
      .error(reason: "IdentityVerificationClient.unimplemented — set a test value.")
    }
  )

  /// Test factory — returns a fixed outcome after an optional simulated
  /// delay. The delay is bounded by the reducer's `ImmediateClock` in
  /// tests, so this is a yield, not a real sleep.
  static func test(outcome: IDScanSDKOutcome) -> IdentityVerificationClient {
    IdentityVerificationClient(
      launchSDK: { _ in outcome }
    )
  }
}

private enum IdentityVerificationClientKey: DependencyKey {
  static let liveValue: IdentityVerificationClient = .live
  static let testValue: IdentityVerificationClient = .unimplemented
}

public extension DependencyValues {
  var identityVerificationClient: IdentityVerificationClient {
    get { self[IdentityVerificationClientKey.self] }
    set { self[IdentityVerificationClientKey.self] = newValue }
  }
}
