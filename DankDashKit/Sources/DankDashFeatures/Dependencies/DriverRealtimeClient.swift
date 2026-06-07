import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork
import SocketIO

/// Client for the `/driver` realtime namespace. Two responsibilities,
/// both delivery-scoped (one active route at a time):
///
///   1. **Publish** the driver's live location at ≤1Hz so the customer's
///      tracking map animates in real time. The server resolves the
///      active delivery from the JWT `sub` and rate-limits to ~1/sec,
///      so the client just streams `driver:location:update {lat, lng}`.
///   2. **Observe** `order:status_changed` for this driver's orders. The
///      driver socket auto-joins `driverRoom(driverId)` server-side on
///      handshake, so status fan-out for any of the driver's orders
///      arrives without a per-order subscribe. The reducer filters the
///      stream by the route it currently owns.
///
/// The `driverId` is intentionally OMITTED from the handshake — the
/// `/driver` auth middleware self-resolves it from `claims.sub`, so the
/// client only carries the access token (mirrors ``RealtimeClient``).
///
/// `SocketManager` / `SocketIOClient` are not `Sendable`; the live
/// binding keeps them inside ``DriverRealtimeConnection`` (an actor) and
/// exposes only the three closures below.
public struct DriverRealtimeClient: Sendable {
  /// Emit one location fix. The connection opens lazily on the first
  /// call and throttles to ≤1Hz; fixes arriving faster than that are
  /// dropped client-side (the server rate-limits too). No-op until the
  /// socket reaches `.connected`.
  public var publishLocation: @Sendable (Coordinate) async -> Void

  /// Stream of status changes for this driver's orders. Opening the
  /// stream connects the socket if it isn't already up. Yields every
  /// `order:status_changed` the driver room receives; the consumer
  /// filters by the order it cares about. Cancelling the stream drops
  /// the subscriber but leaves the socket up for the location publisher.
  public var events: @Sendable () async -> AsyncStream<DriverOrderStatusChange>

  /// Tears the connection down and finishes every active event stream.
  /// Called on route teardown / delivery completion.
  public var disconnect: @Sendable () async -> Void

  public init(
    publishLocation: @Sendable @escaping (Coordinate) async -> Void,
    events: @Sendable @escaping () async -> AsyncStream<DriverOrderStatusChange>,
    disconnect: @Sendable @escaping () async -> Void
  ) {
    self.publishLocation = publishLocation
    self.events = events
    self.disconnect = disconnect
  }
}

/// A status change observed on the `/driver` socket. The reducer maps
/// `status` onto its local delivery phase (advance-only) so a server
/// hop the driver didn't initiate — most importantly the vendor handoff
/// (`en_route_pickup → picked_up`) — reconciles the UI without polling.
public struct DriverOrderStatusChange: Sendable, Equatable {
  public let orderId: UUID
  public let status: OrderStatus
  public let occurredAt: Date

  public init(orderId: UUID, status: OrderStatus, occurredAt: Date) {
    self.orderId = orderId
    self.status = status
    self.occurredAt = occurredAt
  }
}

public extension DriverRealtimeClient {
  /// Production binding against the `/driver` namespace, JWT in
  /// `auth.token`, SocketIO reconnect (exponential backoff capped at
  /// 30s) enabled. The driver room is auto-joined server-side, so there
  /// is no client-side resubscribe to replay on reconnect.
  static func live(
    baseURL: URL,
    accessToken: @Sendable @escaping () async throws -> String
  ) -> DriverRealtimeClient {
    let connection = DriverRealtimeConnection(
      baseURL: baseURL,
      accessTokenProvider: accessToken
    )
    return DriverRealtimeClient(
      publishLocation: { coordinate in await connection.publishLocation(coordinate) },
      events: { await connection.events() },
      disconnect: { await connection.shutdown() }
    )
  }

  /// Test/preview fixture — publishing is a no-op and the event stream
  /// finishes immediately, so a TestStore that forgets to drive status
  /// changes simply observes nothing rather than hanging.
  static let unimplemented = DriverRealtimeClient(
    publishLocation: { _ in },
    events: { AsyncStream { $0.finish() } },
    disconnect: { }
  )
}

private enum DriverRealtimeClientKey: DependencyKey {
  static let liveValue: DriverRealtimeClient = .unimplemented
  static let testValue: DriverRealtimeClient = .unimplemented
}

public extension DependencyValues {
  var driverRealtimeClient: DriverRealtimeClient {
    get { self[DriverRealtimeClientKey.self] }
    set { self[DriverRealtimeClientKey.self] = newValue }
  }
}

// MARK: - SocketIO-backed connection

/// Actor owning the single `/driver` SocketIO connection: the location
/// publisher (throttled) and the status-change broadcaster. Isolated so
/// the non-`Sendable` SocketIO types never cross an actor boundary.
actor DriverRealtimeConnection {
  private let baseURL: URL
  private let accessTokenProvider: @Sendable () async throws -> String

  private var manager: SocketManager?
  private var socket: SocketIOClient?

  /// Open event subscribers keyed by an internal token. The reducer
  /// opens exactly one, but the map keeps the actor honest if a view
  /// re-subscribes before the prior stream finishes.
  private var eventContinuations: [UUID: AsyncStream<DriverOrderStatusChange>.Continuation] = [:]

  /// Client-side publish throttle. The server enforces ~1/sec too, but
  /// dropping here avoids burning the token bucket and the radio.
  private let minPublishInterval: Duration = .seconds(1)
  private let monotonicClock = ContinuousClock()
  private var lastPublishAt: ContinuousClock.Instant?

  init(
    baseURL: URL,
    accessTokenProvider: @Sendable @escaping () async throws -> String
  ) {
    self.baseURL = baseURL
    self.accessTokenProvider = accessTokenProvider
  }

  func publishLocation(_ coordinate: Coordinate) {
    ensureConnected()
    guard socket?.status == .connected else { return }
    let now = monotonicClock.now
    if let last = lastPublishAt, now - last < minPublishInterval { return }
    lastPublishAt = now
    // PostGIS / the server schema expect plain lat/lng doubles. Only the
    // `[String: Any]` dictionary form of `SocketData` is supported by
    // SocketIO-client-swift, hence the explicit cast.
    socket?.emit(
      "driver:location:update",
      ["lat": coordinate.latitude, "lng": coordinate.longitude] as [String: Any]
    )
  }

  func events() -> AsyncStream<DriverOrderStatusChange> {
    AsyncStream { [weak self] continuation in
      guard let self else {
        continuation.finish()
        return
      }
      let token = UUID()
      Task { await self.storeEventContinuation(token: token, continuation: continuation) }
      continuation.onTermination = { [weak self] _ in
        guard let self else { return }
        Task { await self.removeEventContinuation(token: token) }
      }
    }
  }

  func shutdown() {
    for (_, continuation) in eventContinuations {
      continuation.finish()
    }
    eventContinuations.removeAll()
    socket?.disconnect()
    socket = nil
    manager = nil
    lastPublishAt = nil
  }

  // MARK: - Subscriber map

  private func storeEventContinuation(
    token: UUID,
    continuation: AsyncStream<DriverOrderStatusChange>.Continuation
  ) {
    eventContinuations[token] = continuation
    ensureConnected()
  }

  private func removeEventContinuation(token: UUID) {
    eventContinuations.removeValue(forKey: token)
  }

  // MARK: - SocketIO lifecycle

  private func ensureConnected() {
    if manager == nil {
      bootstrap()
    }
  }

  private func bootstrap() {
    let config: SocketIOClientConfiguration = [
      .compress,
      .reconnects(true),
      .reconnectWait(1),
      .reconnectWaitMax(30),
      .forceWebsockets(true),
      .connectParams(["token": ""])
    ]
    let manager = SocketManager(socketURL: baseURL, config: config)
    let socket = manager.socket(forNamespace: "/driver")
    self.manager = manager
    self.socket = socket
    installHandlers(on: socket)

    let provider = accessTokenProvider
    Task { [weak self] in
      do {
        let token = try await provider()
        await self?.connect(with: token)
      } catch {
        // No token: the socket can't authenticate. Leave the streams
        // idle — the reducer's poll fallback still reconciles status,
        // and the next route entry retries the handshake.
        await self?.finishAllEvents()
      }
    }
  }

  private func connect(with token: String) {
    socket?.connect(withPayload: ["token": token])
  }

  private func finishAllEvents() {
    for (_, continuation) in eventContinuations {
      continuation.finish()
    }
    eventContinuations.removeAll()
  }

  private func broadcast(_ change: DriverOrderStatusChange) {
    for (_, continuation) in eventContinuations {
      continuation.yield(change)
    }
  }

  // MARK: - SocketIO handlers

  private func installHandlers(on socket: SocketIOClient) {
    // The driver room is auto-joined server-side on handshake, so there
    // is nothing to re-emit on `.connect`. Status fan-out flows straight
    // to this handler for any of the driver's orders.
    socket.on("order:status_changed") { [weak self] data, _ in
      self?.handleStatusChanged(data: data)
    }
  }

  private nonisolated func handleStatusChanged(data: [Any]) {
    guard let dict = data.first as? [String: Any] else { return }
    guard let payload = try? JSONSerialization.data(withJSONObject: dict) else { return }
    // Reuse the customer-side parser: the `/driver` payload is the same
    // `{orderId, status, occurredAt}` shape with an extra `envelopeId`.
    guard let event = RealtimeEventParser.parse(name: "order:status_changed", payload: payload) else {
      return
    }
    guard case let .statusChanged(orderId, status, occurredAt) = event else { return }
    let change = DriverOrderStatusChange(orderId: orderId, status: status, occurredAt: occurredAt)
    Task { [weak self] in await self?.broadcast(change) }
  }
}
