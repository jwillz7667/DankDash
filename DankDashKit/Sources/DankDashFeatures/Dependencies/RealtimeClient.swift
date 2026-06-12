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
  /// Wired into the root sign-out / account-deletion paths so a socket
  /// authenticated as the previous user never survives an account
  /// switch.
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

extension RealtimeClientError: LocalizedError {
  /// `EquatableError` prefers `errorDescription`, and the order-tracking
  /// banner renders it verbatim — without this conformance the banner
  /// leaked the raw server payload ("{code = TOKEN_EXPIRED; …}") at the
  /// user. Every realtime failure degrades to the 15s polling fallback,
  /// so the human-facing message says that; the associated detail stays
  /// available for logs.
  public var errorDescription: String? {
    switch self {
    case .unimplemented(let surface):
      return "Realtime dependency not wired: \(surface)"
    case .connectionFailed, .decodingFailed:
      return "Live updates paused — updating every few seconds instead."
    }
  }
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

  /// One token-refresh reconnect per connect cycle (reset on a
  /// successful handshake). Without the guard, an expired *refresh*
  /// token would loop handshake-reject → refresh → reject forever.
  private var hasRetriedAuthThisCycle = false

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
    emitUnsubscribe(orderId)
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
    emitUnsubscribe(orderId)
  }

  /// Emitting while disconnected makes socket.io-client-swift raise a
  /// clientEvent `.error` ("Tried emitting when not connected") that the
  /// error handler used to turn into a failAll — closing one order's
  /// screen during a reconnect killed every other order's stream. A
  /// disconnected socket holds no server-side rooms anyway, so the emit
  /// is pointless; drop it.
  private func emitUnsubscribe(_ orderId: UUID) {
    guard socket?.status == .connected else { return }
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
    // No `.connectParams` token — the server reads only
    // `handshake.auth.token`, which `connect(withPayload:)` supplies.
    let config: SocketIOClientConfiguration = [
      .compress,
      .reconnects(true),
      .reconnectWait(1),
      .reconnectWaitMax(30),
      .forceWebsockets(true)
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

  private func handleConnected() {
    hasRetriedAuthThisCycle = false
    resubscribeAll()
  }

  /// `clientEvent: .error` carries everything from handshake rejections
  /// to library-internal emit complaints, so triage before failing
  /// subscriber streams.
  private func handleSocketError(_ detail: String) {
    // Emit-while-disconnected noise: the reconnect machinery is already
    // on it, and the other orders' streams must survive.
    if detail.contains("Tried emitting when not connected") { return }

    guard Self.isAuthRejection(detail), !hasRetriedAuthThisCycle else {
      failAll(with: .connectionFailed(detail))
      return
    }

    // The handshake bounced on a stale JWT (the access token outlives
    // its 15-min TTL whenever a tracking screen opens later). Mint a
    // fresh one and reconnect — `connect(withPayload:)` replaces the
    // library's stored connectPayload, so its own auto-reconnects carry
    // the new token from here on.
    hasRetriedAuthThisCycle = true
    let provider = accessTokenProvider
    Task { [weak self] in
      do {
        let token = try await provider()
        await self?.connect(with: token)
      } catch {
        await self?.failAll(with: .connectionFailed("token refresh failed: \(error)"))
      }
    }
  }

  /// The `/customer` middleware rejects with exactly these codes
  /// (`apps/realtime/src/io/auth-middleware.ts`); all three are curable
  /// by handing the handshake a freshly-refreshed token.
  private static func isAuthRejection(_ detail: String) -> Bool {
    detail.contains("TOKEN_EXPIRED")
      || detail.contains("TOKEN_INVALID")
      || detail.contains("UNAUTHENTICATED")
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
      Task { await self.handleConnected() }
    }
    socket.on(clientEvent: .error) { [weak self] data, _ in
      guard let self else { return }
      let detail = data.first.map { "\($0)" } ?? "unknown"
      Task { await self.handleSocketError(detail) }
    }
    socket.on("order:status_changed") { [weak self] data, _ in
      self?.handle(eventName: "order:status_changed", data: data)
    }
    socket.on("driver:location") { [weak self] data, _ in
      self?.handle(eventName: "driver:location", data: data)
    }
    // Server emits the ETA refresh as `customer:eta_updated` (see
    // packages/realtime-events REALTIME_EVENT_TYPES). There is no
    // `order:driver_assigned` event — driver assignment arrives as a
    // `order:status_changed` → `driver_assigned`, and OrderTracking
    // self-heals the driver profile with a one-shot detail refetch.
    socket.on("customer:eta_updated") { [weak self] data, _ in
      self?.handle(eventName: "customer:eta_updated", data: data)
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
    // The server stamps timestamps with JS `Date.toISOString()`, which
    // always carries fractional seconds (`...:00.000Z`). `.iso8601` uses
    // a formatter without `.withFractionalSeconds`, so it rejects every
    // real payload — decode both shapes defensively.
    decoder.dateDecodingStrategy = .custom { decoder in
      let raw = try decoder.singleValueContainer().decode(String.self)
      guard let date = Self.parseTimestamp(raw) else {
        throw DecodingError.dataCorrupted(
          .init(codingPath: decoder.codingPath, debugDescription: "unparseable ISO-8601 timestamp: \(raw)")
        )
      }
      return date
    }
    switch name {
    case "order:status_changed":
      guard let dto = try? decoder.decode(StatusChangedDTO.self, from: payload) else { return nil }
      guard let orderId = UUID(uuidString: dto.orderId) else { return nil }
      guard let status = OrderStatus(rawValue: dto.toStatus) else { return nil }
      return .statusChanged(orderId: orderId, status: status, occurredAt: dto.changedAt)

    case "driver:location":
      guard let dto = try? decoder.decode(DriverLocationDTO.self, from: payload) else { return nil }
      guard let orderId = UUID(uuidString: dto.orderId) else { return nil }
      let coordinate = Coordinate(latitude: dto.lat, longitude: dto.lng)
      return .driverLocation(orderId: orderId, coordinate: coordinate, capturedAt: dto.recordedAt)

    case "customer:eta_updated":
      guard let dto = try? decoder.decode(EtaUpdatedDTO.self, from: payload) else { return nil }
      guard let orderId = UUID(uuidString: dto.orderId) else { return nil }
      // Wire carries seconds; the UI renders whole minutes.
      let etaMinutes = Int((dto.etaSeconds / 60).rounded())
      return .etaUpdated(orderId: orderId, etaMinutes: etaMinutes, updatedAt: dto.computedAt)

    default:
      return nil
    }
  }

  // `formatOptions` is set once at init and never mutated, and
  // `date(from:)` is safe for concurrent reads — so sharing a single
  // formatter across the socket callback threads is sound.
  private nonisolated(unsafe) static let iso8601Fractional: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  private nonisolated(unsafe) static let iso8601Plain: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
  }()

  private static func parseTimestamp(_ raw: String) -> Date? {
    iso8601Fractional.date(from: raw) ?? iso8601Plain.date(from: raw)
  }

  /// Mirrors `orderStatusChangedPayloadSchema` in `packages/realtime-events`.
  /// Extra wire fields (customerId, dispensaryId, driverId, fromStatus,
  /// envelopeId) are intentionally unmapped — `JSONDecoder` ignores keys
  /// absent from the type.
  struct StatusChangedDTO: Decodable {
    let orderId: String
    let toStatus: String
    let changedAt: Date
  }

  /// Mirrors `driverLocationPayloadSchema`.
  struct DriverLocationDTO: Decodable {
    let orderId: String
    let lat: Double
    let lng: Double
    let recordedAt: Date
  }

  /// Mirrors `customerEtaUpdatedPayloadSchema`.
  struct EtaUpdatedDTO: Decodable {
    let orderId: String
    let etaSeconds: Double
    let computedAt: Date
  }
}
