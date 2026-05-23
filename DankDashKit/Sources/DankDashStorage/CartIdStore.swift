import Foundation

/// UserDefaults-backed `(dispensaryId → cartId)` mapping.
///
/// The server cart is keyed by id, but at app launch the iOS client only
/// knows the *dispensary* the user was browsing — not which cart id
/// belongs to it. This store closes that gap: on Cart-tab open we look up
/// the cached id, fetch it (404/410 falls back to draft promotion), and
/// avoid creating a duplicate cart per dispensary.
///
/// Layout: one defaults key holds a `[String: String]` map keyed by
/// `dispensaryId.uuidString.lowercased()` with `cartId.uuidString.lowercased()`
/// values. Lowercasing matches what we send on the wire so the key shape
/// is stable across reads/writes.
///
/// `@unchecked Sendable` follows the ``UserDefaultsStore`` precedent —
/// `UserDefaults` is documented thread-safe; the struct itself is value-
/// typed with no mutable reference state.
public struct CartIdStore: @unchecked Sendable {
  private let defaults: UserDefaults
  private let key: String

  public init(
    suiteName: String? = nil,
    key: String = "dankdash.cart.dispensaryToCart"
  ) {
    if let suiteName, let suite = UserDefaults(suiteName: suiteName) {
      self.defaults = suite
    } else {
      self.defaults = .standard
    }
    self.key = key
  }

  /// Returns the cached cart id for `dispensaryId` or nil if absent /
  /// malformed. Malformed entries are treated as absent rather than
  /// thrown — the worst-case fallback (call `POST /v1/carts` to create
  /// fresh) is harmless.
  public func cartId(forDispensaryId dispensaryId: UUID) -> UUID? {
    let map = currentMap()
    guard let raw = map[Self.normalize(dispensaryId)] else { return nil }
    return UUID(uuidString: raw)
  }

  /// Sets the cached cart id for `dispensaryId`, replacing any existing
  /// entry. The Phase 18 invariant is one cart per dispensary, so a fresh
  /// cart id overwrites the previous one for that dispensary in place.
  public func set(cartId: UUID, forDispensaryId dispensaryId: UUID) {
    var map = currentMap()
    map[Self.normalize(dispensaryId)] = Self.normalize(cartId)
    defaults.set(map, forKey: key)
  }

  /// Removes the cached cart id for `dispensaryId`. Called after a
  /// completed checkout / order placement so the next visit to the same
  /// dispensary starts a new server cart.
  public func clear(dispensaryId: UUID) {
    var map = currentMap()
    map.removeValue(forKey: Self.normalize(dispensaryId))
    if map.isEmpty {
      defaults.removeObject(forKey: key)
    } else {
      defaults.set(map, forKey: key)
    }
  }

  /// Wipes every (dispensary → cart) mapping. Called on logout so a
  /// different user doesn't inherit the previous user's cart ids.
  public func clearAll() {
    defaults.removeObject(forKey: key)
  }

  // MARK: - Internals

  /// Reads the current map, defensively. A non-dictionary value at the
  /// key (e.g. a defaults file edited by a previous app version) is
  /// treated as empty — we don't throw, we just rebuild.
  private func currentMap() -> [String: String] {
    (defaults.dictionary(forKey: key) as? [String: String]) ?? [:]
  }

  /// All UUIDs land in defaults lowercased so case differences between
  /// `addressId.uuidString` (uppercase) and `id.uuidString.lowercased()`
  /// (what we send to the server) can never produce two entries for the
  /// same logical dispensary.
  static func normalize(_ id: UUID) -> String {
    id.uuidString.lowercased()
  }
}
