import Foundation

/// Typed projection of an incoming `dankdash://...` URL. The router is
/// pure — it knows nothing about reducer state — so unit tests can pin
/// every supported shape and every malformed case to a stable enum
/// value without standing up a store.
public enum DeepLinkRoute: Equatable, Sendable {
  /// `dankdash://order/complete?orderId=<UUID>` — emitted by
  /// `checkout-web` after `POST /v1/carts/:id/checkout` succeeds. The
  /// app dismisses the Safari sheet, switches to the Orders tab, and
  /// pushes the tracking screen for `orderId`.
  case orderComplete(orderId: UUID)
}

/// Pure parser from incoming `URL` to ``DeepLinkRoute``. All four
/// failure modes (wrong scheme, unknown host/path, missing query, bad
/// UUID) collapse to `nil` so the caller can fall back to no-op behavior
/// instead of surfacing a parse error to the user.
///
/// The router does NOT depend on `URLComponents.queryItems` lazily —
/// it walks the components defensively so a path-only URL
/// (`dankdash://order/complete`) without `?orderId=` short-circuits to
/// nil rather than crashing on optional unwrap.
public enum DeepLinkRouter {
  /// The custom URL scheme registered in `Info.plist` under
  /// `CFBundleURLTypes`. Universal Links land in Phase 19+ (see plan
  /// "Deferred" section) — until then the consumer surface uses the
  /// custom scheme.
  public static let scheme = "dankdash"

  /// Returns the parsed route or `nil` if the URL doesn't match any
  /// known shape. Callers should treat `nil` as "ignore this URL" —
  /// it is normal for arbitrary URLs to land in `.onOpenURL` (e.g.
  /// when the user pastes a link into the app), and we do not want
  /// those to noisily fail.
  public static func route(_ url: URL) -> DeepLinkRoute? {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      return nil
    }
    guard components.scheme?.lowercased() == scheme else { return nil }

    let host = components.host?.lowercased()
    // URL parsing for `dankdash://order/complete?...` puts "order" in
    // `host` and "/complete" in `path`. We normalize the path by
    // stripping the leading slash so the switch reads like
    // (host, path) regardless of formatting.
    let path = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))

    switch (host, path) {
    case ("order", "complete"):
      guard let raw = components.queryItems?.first(where: { $0.name == "orderId" })?.value,
            let orderId = UUID(uuidString: raw) else {
        return nil
      }
      return .orderComplete(orderId: orderId)

    default:
      return nil
    }
  }
}
