import Foundation

/// One of the five user-controllable notification toggles. Two axes:
/// *category* (which kinds of notifications) and *channel* (how they
/// arrive). `in_app` is deliberately absent — the in-app inbox record is
/// always written and has no toggle.
public enum NotificationToggle: String, Sendable, Codable, Hashable, CaseIterable {
  // Category axis — the only user-suppressible kinds. Transactional
  // (account) and operational (driver/vendor) notifications ignore these.
  case orderUpdates
  case promotions
  // Channel axis.
  case push
  case sms
  case email
}

/// The caller's notification delivery preferences. Mirror of
/// `NotificationPreferencesResponse` (`GET /v1/me/notification-preferences`).
///
/// Opt-out model: every toggle defaults to `true`, and a user who has never
/// saved any preference is served the all-on defaults with a `nil`
/// `updatedAt` (no row exists server-side yet).
///
/// Suppression is the AND of the two axes — a delivery is dropped when its
/// category is off OR its channel is off. The server is authoritative; this
/// value type is the client mirror that drives the settings switches and
/// the local checkout/preview is never the source of truth.
public struct NotificationPreferences: Equatable, Hashable, Sendable, Codable {
  public var orderUpdatesEnabled: Bool
  public var promotionsEnabled: Bool
  public var pushEnabled: Bool
  public var smsEnabled: Bool
  public var emailEnabled: Bool
  /// `nil` until the user first saves a preference (no row server-side).
  public var updatedAt: Date?

  public init(
    orderUpdatesEnabled: Bool = true,
    promotionsEnabled: Bool = true,
    pushEnabled: Bool = true,
    smsEnabled: Bool = true,
    emailEnabled: Bool = true,
    updatedAt: Date? = nil
  ) {
    self.orderUpdatesEnabled = orderUpdatesEnabled
    self.promotionsEnabled = promotionsEnabled
    self.pushEnabled = pushEnabled
    self.smsEnabled = smsEnabled
    self.emailEnabled = emailEnabled
    self.updatedAt = updatedAt
  }

  /// All-on defaults — what a brand-new account sees before saving anything.
  public static let allOn = NotificationPreferences()

  /// Reads the current value of a single toggle.
  public func value(for toggle: NotificationToggle) -> Bool {
    switch toggle {
    case .orderUpdates: orderUpdatesEnabled
    case .promotions: promotionsEnabled
    case .push: pushEnabled
    case .sms: smsEnabled
    case .email: emailEnabled
    }
  }

  /// Returns a copy with a single toggle set — used for the optimistic UI
  /// flip before the PATCH resolves (and to revert it if the PATCH fails).
  public func setting(_ toggle: NotificationToggle, to value: Bool) -> NotificationPreferences {
    var copy = self
    switch toggle {
    case .orderUpdates: copy.orderUpdatesEnabled = value
    case .promotions: copy.promotionsEnabled = value
    case .push: copy.pushEnabled = value
    case .sms: copy.smsEnabled = value
    case .email: copy.emailEnabled = value
    }
    return copy
  }
}

/// Partial update for `PATCH /v1/me/notification-preferences`. Every field
/// is optional; only the non-nil toggles are sent, so flipping one switch
/// sends exactly one key. An all-nil patch is illegal — the server rejects
/// an empty body (422) — which ``isEmpty`` lets the client guard against.
public struct NotificationPreferencesUpdate: Equatable, Hashable, Sendable {
  public var orderUpdatesEnabled: Bool?
  public var promotionsEnabled: Bool?
  public var pushEnabled: Bool?
  public var smsEnabled: Bool?
  public var emailEnabled: Bool?

  public init(
    orderUpdatesEnabled: Bool? = nil,
    promotionsEnabled: Bool? = nil,
    pushEnabled: Bool? = nil,
    smsEnabled: Bool? = nil,
    emailEnabled: Bool? = nil
  ) {
    self.orderUpdatesEnabled = orderUpdatesEnabled
    self.promotionsEnabled = promotionsEnabled
    self.pushEnabled = pushEnabled
    self.smsEnabled = smsEnabled
    self.emailEnabled = emailEnabled
  }

  /// A patch carrying exactly one toggle — the shape every switch flip
  /// produces.
  public static func single(
    _ toggle: NotificationToggle,
    to value: Bool
  ) -> NotificationPreferencesUpdate {
    switch toggle {
    case .orderUpdates: NotificationPreferencesUpdate(orderUpdatesEnabled: value)
    case .promotions: NotificationPreferencesUpdate(promotionsEnabled: value)
    case .push: NotificationPreferencesUpdate(pushEnabled: value)
    case .sms: NotificationPreferencesUpdate(smsEnabled: value)
    case .email: NotificationPreferencesUpdate(emailEnabled: value)
    }
  }

  /// True when no toggle is set — the client must not send such a patch.
  public var isEmpty: Bool {
    orderUpdatesEnabled == nil
      && promotionsEnabled == nil
      && pushEnabled == nil
      && smsEnabled == nil
      && emailEnabled == nil
  }
}
