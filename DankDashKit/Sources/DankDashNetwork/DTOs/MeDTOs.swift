import Foundation

/// Request body for `PATCH /v1/me`. Mirrors `UpdateMeRequestSchema` in
/// `apps/api/src/modules/identity/dto/me.dto.ts`: the server schema is
/// `.strict().partial()` over `{ firstName, lastName }` (each trimmed,
/// 1–80 chars) and rejects an empty object, so the client must send at
/// least one field and never an unknown key.
///
/// The custom `encode(to:)` omits nil fields rather than emitting
/// `lastName: null` — a name-only edit must not be read by `.strict()`
/// as an unexpected null, and a partial update must stay partial.
public struct UpdateMeRequestDTO: Encodable, Sendable, Equatable {
  public let firstName: String?
  public let lastName: String?

  public init(firstName: String? = nil, lastName: String? = nil) {
    self.firstName = firstName
    self.lastName = lastName
  }

  private enum CodingKeys: String, CodingKey {
    case firstName
    case lastName
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encodeIfPresent(firstName, forKey: .firstName)
    try container.encodeIfPresent(lastName, forKey: .lastName)
  }
}
