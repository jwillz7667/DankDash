import Foundation
import ComposableArchitecture
import DankDashStorage

/// `@DependencyClient`-style abstraction over ``DriverSessionStore``.
/// The shift reducer reads on `.onAppear` to recover an active shift
/// across a cold launch, writes when the toggle goes online, updates
/// the heartbeat as samples arrive, and clears on toggle-offline /
/// logout.
public struct DriverSessionStoreClient: Sendable {
  public var read: @Sendable () async -> DriverSessionStore.Snapshot?
  public var write: @Sendable (DriverSessionStore.Snapshot) async -> Void
  public var updateHeartbeat: @Sendable (_ lat: Double?, _ lng: Double?, _ at: Date) async -> Void
  public var clear: @Sendable () async -> Void

  public init(
    read: @Sendable @escaping () async -> DriverSessionStore.Snapshot?,
    write: @Sendable @escaping (DriverSessionStore.Snapshot) async -> Void,
    updateHeartbeat: @Sendable @escaping (_ lat: Double?, _ lng: Double?, _ at: Date) async -> Void,
    clear: @Sendable @escaping () async -> Void
  ) {
    self.read = read
    self.write = write
    self.updateHeartbeat = updateHeartbeat
    self.clear = clear
  }
}

public extension DriverSessionStoreClient {
  static func live(
    store: DriverSessionStore = DriverSessionStore()
  ) -> DriverSessionStoreClient {
    DriverSessionStoreClient(
      read: { store.read() },
      write: { snapshot in store.write(snapshot) },
      updateHeartbeat: { lat, lng, at in
        store.updateHeartbeat(lat: lat, lng: lng, at: at)
      },
      clear: { store.clear() }
    )
  }

  static let unimplemented = DriverSessionStoreClient(
    read: { nil },
    write: { _ in },
    updateHeartbeat: { _, _, _ in },
    clear: {}
  )
}

private enum DriverSessionStoreClientKey: DependencyKey {
  static let liveValue: DriverSessionStoreClient = .live()
  static let testValue: DriverSessionStoreClient = .unimplemented
}

public extension DependencyValues {
  var driverSessionStoreClient: DriverSessionStoreClient {
    get { self[DriverSessionStoreClientKey.self] }
    set { self[DriverSessionStoreClientKey.self] = newValue }
  }
}
