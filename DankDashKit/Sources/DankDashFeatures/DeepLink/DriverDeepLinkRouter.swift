import Foundation

/// Typed projection of an incoming `dankdasher://...` URL — the driver
/// app's sibling to ``DeepLinkRoute``. Kept as its own enum (rather than
/// piling driver cases onto the consumer router) because the two apps
/// register distinct URL schemes and route into very different reducer
/// surfaces: consumer routes feed the Orders tab, driver routes
/// feed ``DriverRootFeature``.
///
/// Phase 20 introduces a single shape, the dispatch-offer hand-off:
///
///   `dankdasher://offer/<orderId>` — APNs critical-alert push payload
///   includes this URL so a cold-start from the lock screen lands the
///   driver on the active-route surface for `orderId`. The reducer's
///   ``DriverRootFeature/Action/startActiveRoute(orderId:)`` is the
///   landing action.
public enum DriverDeepLinkRoute: Equatable, Sendable {
  /// `dankdasher://offer/<orderId>` — APNs push hand-off to the active
  /// delivery for `orderId`. The router accepts the order UUID in either
  /// the `host` slot (`dankdasher://offer/<uuid>`) or the first path
  /// component, because iOS occasionally normalizes single-segment hosts
  /// down to the path on cold-launch URL reconstruction.
  case offer(orderId: UUID)
}

/// Pure parser from `URL` to ``DriverDeepLinkRoute``. Mirrors the
/// consumer's ``DeepLinkRouter`` — every malformed input collapses to
/// `nil` so the caller treats it as a no-op, the way the
/// ``DankDasherApp/onOpenURL`` plumbing already does.
///
/// `dankdasher://offer/<uuid>` parses with `host = "offer"`, `path =
/// "/<uuid>"`. We strip the leading slash so the comparison reads as a
/// tuple of `(host, firstPathComponent)`. The UUID itself is decoded
/// case-insensitively via `UUID(uuidString:)` and rejected if it
/// doesn't round-trip.
public enum DriverDeepLinkRouter {
  /// Custom URL scheme declared in `DankDasher/Info.plist`. Universal
  /// Links land in a later phase; until then APNs payloads use the
  /// scheme directly.
  public static let scheme = "dankdasher"

  public static func route(_ url: URL) -> DriverDeepLinkRoute? {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      return nil
    }
    guard components.scheme?.lowercased() == scheme else { return nil }

    let host = components.host?.lowercased()
    let trimmed = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    let pathSegments = trimmed.isEmpty ? [] : trimmed.split(separator: "/").map(String.init)

    switch host {
    case "offer":
      guard let raw = pathSegments.first, let orderId = UUID(uuidString: raw) else {
        return nil
      }
      return .offer(orderId: orderId)

    default:
      return nil
    }
  }
}
