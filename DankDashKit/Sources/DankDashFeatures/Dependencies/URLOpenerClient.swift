import Foundation
import ComposableArchitecture
#if canImport(UIKit)
import UIKit
#endif

/// `@DependencyClient`-style abstraction over `UIApplication.open(_:)`.
/// Reducers depend on this struct so deep-link / external-URL tests
/// substitute a closure that records the URL instead of opening it in
/// the real Safari handler.
///
/// The closure returns `true` when the system reported a successful
/// open. `false` covers both "no application handles this URL" on iOS
/// and the macOS / test-target fallback where we don't actually open
/// anything.
public struct URLOpenerClient: Sendable {
  public var open: @Sendable (_ url: URL) async -> Bool

  public init(open: @Sendable @escaping (_ url: URL) async -> Bool) {
    self.open = open
  }
}

public extension URLOpenerClient {
  /// Production binding. Only available on iOS — `UIApplication.open`
  /// is iOS-only. On macOS (which we build only for `swift test`) the
  /// live binding falls back to the `.unimplemented` fixture.
  #if canImport(UIKit)
  static let live = URLOpenerClient(
    open: { url in
      await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
        Task { @MainActor in
          UIApplication.shared.open(url, options: [:]) { success in
            continuation.resume(returning: success)
          }
        }
      }
    }
  )
  #else
  static let live: URLOpenerClient = .unimplemented
  #endif

  /// Test fixture that always reports "couldn't open". Reducer tests
  /// substitute a custom closure that records the URL into an actor
  /// for assertion.
  static let unimplemented = URLOpenerClient(
    open: { _ in false }
  )
}

private enum URLOpenerClientKey: DependencyKey {
  static let liveValue: URLOpenerClient = .live
  static let testValue: URLOpenerClient = .unimplemented
}

public extension DependencyValues {
  var urlOpenerClient: URLOpenerClient {
    get { self[URLOpenerClientKey.self] }
    set { self[URLOpenerClientKey.self] = newValue }
  }
}
