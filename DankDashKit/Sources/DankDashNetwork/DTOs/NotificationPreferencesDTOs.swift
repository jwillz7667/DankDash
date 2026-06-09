import Foundation
import DankDashDomain

/// Wire shape for `NotificationPreferencesResponseSchema`
/// (`GET`/`PATCH /v1/me/notification-preferences`). The five booleans are
/// always present; `updatedAt` is an ISO-8601 string or `null` (the latter
/// for a user who never saved — the server synthesizes the all-on defaults
/// without writing a row).
///
/// `toDomain()` is non-failing: the booleans decode directly, and a
/// present-but-malformed `updatedAt` degrades to `nil` rather than dropping
/// an otherwise valid preference payload. The timestamp is display-only
/// metadata, never a gate.
public struct NotificationPreferencesResponseDTO: Decodable, Sendable, Equatable {
  public let orderUpdatesEnabled: Bool
  public let promotionsEnabled: Bool
  public let pushEnabled: Bool
  public let smsEnabled: Bool
  public let emailEnabled: Bool
  public let updatedAt: String?

  public init(
    orderUpdatesEnabled: Bool,
    promotionsEnabled: Bool,
    pushEnabled: Bool,
    smsEnabled: Bool,
    emailEnabled: Bool,
    updatedAt: String?
  ) {
    self.orderUpdatesEnabled = orderUpdatesEnabled
    self.promotionsEnabled = promotionsEnabled
    self.pushEnabled = pushEnabled
    self.smsEnabled = smsEnabled
    self.emailEnabled = emailEnabled
    self.updatedAt = updatedAt
  }
}

public extension NotificationPreferencesResponseDTO {
  func toDomain() -> NotificationPreferences {
    NotificationPreferences(
      orderUpdatesEnabled: orderUpdatesEnabled,
      promotionsEnabled: promotionsEnabled,
      pushEnabled: pushEnabled,
      smsEnabled: smsEnabled,
      emailEnabled: emailEnabled,
      updatedAt: updatedAt.flatMap(CatalogWire.parseISO8601)
    )
  }
}

/// Body for `PATCH /v1/me/notification-preferences`. Every field is optional
/// so the synthesized `Encodable` omits any `nil` toggle (`encodeIfPresent`)
/// — flipping a single switch serializes a single key, satisfying the
/// server's "at least one preference" rule without sending stale values for
/// the untouched toggles.
public struct UpdateNotificationPreferencesRequestDTO: Encodable, Sendable, Equatable {
  public let orderUpdatesEnabled: Bool?
  public let promotionsEnabled: Bool?
  public let pushEnabled: Bool?
  public let smsEnabled: Bool?
  public let emailEnabled: Bool?

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

  /// Projects a domain patch onto the wire body verbatim — the optionality
  /// (and therefore which keys are sent) carries straight through.
  public init(_ update: NotificationPreferencesUpdate) {
    self.orderUpdatesEnabled = update.orderUpdatesEnabled
    self.promotionsEnabled = update.promotionsEnabled
    self.pushEnabled = update.pushEnabled
    self.smsEnabled = update.smsEnabled
    self.emailEnabled = update.emailEnabled
  }
}
