import Foundation

/// UserDefaults-backed snapshot of the driver's active shift.
///
/// The shift home reducer is the system of record for "am I online";
/// this store exists so a cold-start launch (force-quit + relaunch)
/// can re-hydrate the shift id + start time without round-tripping the
/// server. The reducer reads on `.onAppear`, calls `GET /v1/driver/me`
/// to reconcile, and tears the cache down on shift-end.
///
/// Layout: one JSON-encoded value under a single key. We keep it
/// JSON-encoded (rather than per-field defaults) so additions don't
/// require defaults-schema migrations — the optional decode just
/// surfaces nil for an old shape.
///
/// `@unchecked Sendable` follows the ``CartIdStore`` / ``CatalogCache``
/// precedent — `UserDefaults` is documented thread-safe; the struct is
/// pure value semantics.
public struct DriverSessionStore: @unchecked Sendable {
  /// What we persist on disk. Versioned in the field name (a future
  /// `v2`-style migration just adds a new key + Optional decode) so a
  /// rebrand of the record's shape doesn't poison cold-start reads.
  public struct Snapshot: Codable, Sendable, Equatable {
    public let shiftId: UUID
    public let startedAt: Date
    public let lastKnownLocationLat: Double?
    public let lastKnownLocationLng: Double?
    public let lastHeartbeatAt: Date?

    public init(
      shiftId: UUID,
      startedAt: Date,
      lastKnownLocationLat: Double? = nil,
      lastKnownLocationLng: Double? = nil,
      lastHeartbeatAt: Date? = nil
    ) {
      self.shiftId = shiftId
      self.startedAt = startedAt
      self.lastKnownLocationLat = lastKnownLocationLat
      self.lastKnownLocationLng = lastKnownLocationLng
      self.lastHeartbeatAt = lastHeartbeatAt
    }
  }

  private let defaults: UserDefaults
  private let key: String
  private let encoder: JSONEncoder
  private let decoder: JSONDecoder

  public init(
    suiteName: String? = nil,
    key: String = "dankdasher.session.activeShift"
  ) {
    if let suiteName, let suite = UserDefaults(suiteName: suiteName) {
      self.defaults = suite
    } else {
      self.defaults = .standard
    }
    self.key = key
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    self.encoder = encoder
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    self.decoder = decoder
  }

  /// Returns the current snapshot or nil if no active shift / corrupt
  /// payload. Corrupt entries are treated as absent — the reducer's
  /// fallback ("call /v1/driver/me, render whatever the server says")
  /// is harmless.
  public func read() -> Snapshot? {
    guard let data = defaults.data(forKey: key) else { return nil }
    return try? decoder.decode(Snapshot.self, from: data)
  }

  /// Writes `snapshot` atomically by virtue of `UserDefaults.set(_:)`.
  /// Caller-driven idempotency — re-writing the same shift id every
  /// heartbeat is fine.
  public func write(_ snapshot: Snapshot) {
    guard let data = try? encoder.encode(snapshot) else { return }
    defaults.set(data, forKey: key)
  }

  /// Mutates the snapshot's last-known location + heartbeat in place.
  /// Used by the shift reducer on each `BackgroundLocationClient`
  /// sample so a cold start lands the pin near where the driver was.
  /// No-ops if no snapshot is active (the toggle-online path writes
  /// the snapshot before any sample is consumed).
  public func updateHeartbeat(
    lat: Double?,
    lng: Double?,
    at heartbeatAt: Date
  ) {
    guard let current = read() else { return }
    let next = Snapshot(
      shiftId: current.shiftId,
      startedAt: current.startedAt,
      lastKnownLocationLat: lat ?? current.lastKnownLocationLat,
      lastKnownLocationLng: lng ?? current.lastKnownLocationLng,
      lastHeartbeatAt: heartbeatAt
    )
    write(next)
  }

  /// Tears the snapshot down. Called on shift-end (the dispatch
  /// counterpart is closed by `POST /v1/driver/shift/end`) and on
  /// logout (different user, different shift).
  public func clear() {
    defaults.removeObject(forKey: key)
  }
}
