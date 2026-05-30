import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashStorage

/// `@DependencyClient`-style abstraction over
/// ``DriverApplicationDraftStore``. The driver onboarding reducer
/// depends on this typed surface so `TestStore` tests can substitute
/// in-memory implementations without touching the Application Support
/// directory.
///
/// The Phase 19 invariant is one active draft per device — the
/// onboarding reducer persists the draft on every step transition and
/// reads it on cold start to resume in-progress applications. Clearing
/// happens on submit-success and on logout.
public struct DriverApplicationDraftStoreClient: Sendable {
  public var read: @Sendable () async -> DriverApplicationDraft?
  public var write: @Sendable (DriverApplicationDraft) async throws -> Void
  public var clear: @Sendable () async throws -> Void

  public init(
    read: @Sendable @escaping () async -> DriverApplicationDraft?,
    write: @Sendable @escaping (DriverApplicationDraft) async throws -> Void,
    clear: @Sendable @escaping () async throws -> Void
  ) {
    self.read = read
    self.write = write
    self.clear = clear
  }
}

public extension DriverApplicationDraftStoreClient {
  /// Production binding over ``DriverApplicationDraftStore``. The store
  /// is sync internally; we wrap the calls in `async` for parity with
  /// the rest of the dependency surface and to give us room to move to
  /// a background actor later without churning call sites.
  static func live(
    store: DriverApplicationDraftStore = DriverApplicationDraftStore()
  ) -> DriverApplicationDraftStoreClient {
    DriverApplicationDraftStoreClient(
      read: { store.read() },
      write: { draft in try store.write(draft) },
      clear: { try store.clear() }
    )
  }

  /// Test fixture: reads always miss, writes/clears are no-ops. Reducer
  /// tests substitute closures backed by an in-memory dictionary when
  /// they need the store to round-trip.
  static let unimplemented = DriverApplicationDraftStoreClient(
    read: { nil },
    write: { _ in },
    clear: {}
  )
}

private enum DriverApplicationDraftStoreClientKey: DependencyKey {
  static let liveValue: DriverApplicationDraftStoreClient = .live()
  static let testValue: DriverApplicationDraftStoreClient = .unimplemented
}

public extension DependencyValues {
  var driverApplicationDraftStoreClient: DriverApplicationDraftStoreClient {
    get { self[DriverApplicationDraftStoreClientKey.self] }
    set { self[DriverApplicationDraftStoreClientKey.self] = newValue }
  }
}
