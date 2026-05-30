import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork
import SocketIO

/// Client for the `/customer` realtime namespace. Reducers depend on
/// this struct rather than `SocketIO` directly so TestStore tests
/// substitute typed closures without touching the network.
///
/// The single persistent connection model is per-app-lifecycle: the
/// first `subscribe` opens the socket, subsequent subscribes re-use it,
/// and `disconnect` tears the whole thing down. Cancelling a subscribe
/// stream unsubscribes the room but leaves the connection up — the
/// next subscriber finds a warm socket.
///
/// Reconnect / re-subscribe is built into the actor that backs `.live`
/// (`RealtimeSocketConnection`); on reconnect every room that was
/// subscribed at disconnect-time is resubscribed before the streams
/// emit again.
public struct RealtimeClient: Sendable {
  /// Subscribe to events for one order. The stream yields exactly the
  /// `RealtimeOrderEvent` cases — unknown event names from a future
  /// server release are silently dropped. Cancelling the stream
  /// unsubscribes the order room.
  public var subscribe: @Sendable (UUID) async -> AsyncThrowingStream<RealtimeOrderEvent, Error>

  /// Drops the order subscription without cancelling the AsyncThrowingStream
  /// directly. Either path works — the actor reconciles both. Tests use
  /// this to assert the "stream cancellation emits unsubscribe" path.
  public var unsubscribe: @Sendable (UUID) async -> Void

  /// Closes the underlying connection and finishes every active stream.
  /// Used on logout and on the OrdersTab teardown.
  public var disconnect: @Sendable () async -> Void

  public init(
    subscribe: @Sendable @escaping (UUID) async -> AsyncThrowingStream<RealtimeOrderEvent, Error>,
    unsubscribe: @Sendable @escaping (UUID) async -> Void,
    disconnect: @Sendable @escaping () async -> Void
  ) {
    self.subscribe = subscribe
    self.unsubscribe = unsubscribe
    self.disconnect = disconnect
  }
}

public extension RealtimeClient {
  /// Production binding. Opens a single `SocketManager` against the
  /// `/customer` namespace, JWT in `auth.token`, with SocketIO's built-in
  /// reconnect (exponential backoff capped at 30s) enabled. On reconnect
  /// the actor re-emits `subscribe:order:<id>` for every order id with
  /// an open continuation.
  static func live(
    baseURL: URL,
    accessToken: @Sendable @escaping () async throws -> String
  ) -> RealtimeClient {
    let connection = RealtimeSocketConnection(
      baseURL: baseURL,
      accessTokenProvider: accessToken
    )
    return RealtimeClient(
      subscribe: { orderId in await connection.subscribe(orderId: orderId) },
      unsubscribe: { orderId in await connection.unsubscribe(orderId: orderId) },
      disconnect: { await connection.shutdown() }
    )
  }

  /// Test fixture — every subscribe finishes the stream with an
  /// `unimplemented` error so TestStore tests that forget to stub the
  /// dependency fail loudly.
  static let unimplemented = RealtimeClient(
    subscribe: { _ in
      AsyncThrowingStream { continuation in
        continuation.finish(throwing: RealtimeClientError.unimplemented("subscribe"))
      }
    },
    unsubscribe: { _ in },
    disconnect: { }
  )
}

public enum RealtimeClientError: Error, Sendable, Equatable {
  case unimplemented(String)
  case connectionFailed(String)
  case decodingFailed(String)
}

private enum RealtimeClientKey: DependencyKey {
  static let liveValue: RealtimeClient = .unimplemented
  static let testValue: RealtimeClient = .unimplemented
}

public extension DependencyValues {
  var realtimeClient: RealtimeClient {
    get { self[RealtimeClientKey.self] }
    set { self[RealtimeClientKey.self] = newValue }
  }
}

// MARK: - SocketIO-backed connection

/// Actor that owns the single SocketIO connection and the map of
/// subscriber continuations. Isolated to keep `SocketManager` and
/// `SocketIOClient` (which are not `Sendable`) inside one actor context.
/// Public surface is the three methods called by `RealtimeClient.live`.
actor RealtimeSocketConnection {
  private let baseURL: URL
  private let accessTokenProvider: @Sendable () async throws -> String

  /// SocketIO state. Lazily constructed on first subscribe so the simple
  /// case ("user never opens Orders tab") doesn't open a socket.
  private var manager: SocketManager?
  private var socket: SocketIOClient?

  /// Open subscribers keyed by order id. The continuation is the source
  /// of truth — terminating it (via `finish` or cancel) removes the
  /// subscription.
  private var continuations: [UUID: AsyncThrowingStream<RealtimeOrderEvent, Error>.Continuation] = [:]

  init(
    baseURL: URL,
    accessTokenProvider: @Sendable @escaping () async throws -> String
  ) {
    self.baseURL = baseURL
    self.accessTokenProvider = accessTokenProvider
  }

  func subscribe(orderId: UUID) -> AsyncThrowingStream<RealtimeOrderEvent, Error> {
    AsyncThrowingStream { [weak self] continuation in
      guard let self else {
        continuation.finish()
        return
      }
      Task { await self.storeContinuation(orderId: orderId, continuation: continuation) }
      continuation.onTermination = { [weak self] _ in
        guard let self else { return }
        Task { await self.removeContinuation(orderId: orderId) }
      }
    }
  }

  func unsubscribe(orderId: UUID) {
    if let existing = continuations.removeValue(forKey: orderId) {
      existing.finish()
    }
    socket?.emit("unsubscribe:order", orderId.uuidString.lowercased())
  }

  func shutdown() {
    for (_, continuation) in continuations {
      continuation.finish()
    }
    continuations.removeAll()
    socket?.disconnect()
    socket = nil
    manager = nil
  }

  // MARK: - Continuation map

  private func storeContinuation(
    orderId: UUID,
    continuation: AsyncThrowingStream<RealtimeOrderEvent, Error>.Continuation
  ) {
    if let previous = continuations[orderId] {
      previous.finish()
    }
    continuations[orderId] = continuation
    ensureConnectedAndSubscribed(to: orderId)
  }

  private func removeContinuation(orderId: UUID) {
    continuations.removeValue(forKey: orderId)
    socket?.emit("unsubscribe:order", orderId.uuidString.lowercased())
  }

  // MARK: - SocketIO lifecycle

  private func ensureConnectedAndSubscribed(to orderId: UUID) {
    if manager == nil {
      bootstrap()
    }
    if socket?.status == .connected {
      socket?.emit("subscribe:order", orderId.uuidString.lowercased())
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
    let socket = manager.socket(forNamespace: "/customer")
    self.manager = manager
    self.socket = socket
    installHandlers(on: socket)

    let provider = accessTokenProvider
    Task { [weak self] in
      do {
        let token = try await provider()
        await self?.connect(with: token)
      } catch {
        await self?.failAll(with: .connectionFailed("no access token: \(error)"))
      }
    }
  }

  private func connect(with token: String) {
    socket?.connect(withPayload: ["token": token])
  }

  private func failAll(with error: RealtimeClientError) {
    for (_, continuation) in continuations {
      continuation.finish(throwing: error)
    }
    continuations.removeAll()
  }

  private func resubscribeAll() {
    guard let socket else { return }
    for orderId in continuations.keys {
      socket.emit("subscribe:order", orderId.uuidString.lowercased())
    }
  }

  private func yield(_ event: RealtimeOrderEvent) {
    continuations[event.orderId]?.yield(event)
  }

  // MARK: - SocketIO handlers

  private func installHandlers(on socket: SocketIOClient) {
    socket.on(clientEvent: .connect) { [weak self] _, _ in
      guard let self else { return }
      Task { await self.resubscribeAll() }
    }
    socket.on(clientEvent: .error) { [weak self] data, _ in
      guard let self else { return }
      let detail = data.first.map { "\($0)" } ?? "unknown"
      Task { await self.failAll(with: .connectionFailed(detail)) }
    }
    socket.on("order:status_changed") { [weak self] data, _ in
      self?.handle(eventName: "order:status_changed", data: data)
    }
    socket.on("order:driver_assigned") { [weak self] data, _ in
      self?.handle(eventName: "order:driver_assigned", data: data)
    }
    socket.on("driver:location") { [weak self] data, _ in
      self?.handle(eventName: "driver:location", data: data)
    }
    socket.on("order:eta_updated") { [weak self] data, _ in
      self?.handle(eventName: "order:eta_updated", data: data)
    }
  }

  private nonisolated func handle(eventName: String, data: [Any]) {
    guard let dict = data.first as? [String: Any] else { return }
    guard let payload = try? JSONSerialization.data(withJSONObject: dict) else { return }
    guard let event = RealtimeEventParser.parse(name: eventName, payload: payload) else { return }
    Task { [weak self] in await self?.yield(event) }
  }
}

// MARK: - Parser

/// Pure decoder from `(event name, JSON bytes)` to a `RealtimeOrderEvent`.
/// Lifted out of the actor so it can be tested without touching SocketIO.
enum RealtimeEventParser {
  static func parse(name: String, payload: Data) -> RealtimeOrderEvent? {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    switch name {
    case "order:status_changed":
      guard let dto = try? decoder.decode(StatusChangedDTO.self, from: payload) else { return nil }
      guard let orderId = UUID(uuidString: dto.orderId) else { return nil }
      guard let status = OrderStatus(rawValue: dto.status) else { return nil }
      return .statusChanged(orderId: orderId, status: status, occurredAt: dto.occurredAt)

    case "order:driver_assigned":
      guard let dto = try? decoder.decode(DriverAssignedDTO.self, from: payload) else { return nil }
      guard let orderId = UUID(uuidString: dto.orderId) else { return nil }
      guard let driverId = UUID(uuidString: dto.driver.id) else { return nil }
      let driver = DriverPublicProfile(
        id: driverId,
        displayName: dto.driver.displayName,
        avatarKey: dto.driver.avatarKey,
        vehicleSummary: dto.driver.vehicleSummary,
        maskedPhone: dto.driver.maskedPhone
      )
      return .driverAssigned(orderId: orderId, driver: driver, occurredAt: dto.occurredAt)

    case "driver:location":
      guard let dto = try? decoder.decode(DriverLocationDTO.self, from: payload) else { return nil }
      guard let orderId = UUID(uuidString: dto.orderId) else { return nil }
      let coordinate = Coordinate(latitude: dto.latitude, longitude: dto.longitude)
      return .driverLocation(orderId: orderId, coordinate: coordinate, capturedAt: dto.capturedAt)

    case "order:eta_updated":
      guard let dto = try? decoder.decode(EtaUpdatedDTO.self, from: payload) else { return nil }
      guard let orderId = UUID(uuidString: dto.orderId) else { return nil }
      return .etaUpdated(orderId: orderId, etaMinutes: dto.etaMinutes, updatedAt: dto.updatedAt)

    default:
      return nil
    }
  }

  struct StatusChangedDTO: Decodable {
    let orderId: String
    let status: String
    let occurredAt: Date
  }

  struct DriverAssignedDTO: Decodable {
    let orderId: String
    let driver: DriverDTO
    let occurredAt: Date

    struct DriverDTO: Decodable {
      let id: String
      let displayName: String
      let avatarKey: String?
      let vehicleSummary: String?
      let maskedPhone: String?
    }
  }

  struct DriverLocationDTO: Decodable {
    let orderId: String
    let latitude: Double
    let longitude: Double
    let capturedAt: Date
  }

  struct EtaUpdatedDTO: Decodable {
    let orderId: String
    let etaMinutes: Int
    let updatedAt: Date
  }
}
