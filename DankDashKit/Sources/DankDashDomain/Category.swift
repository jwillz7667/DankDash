import Foundation

/// Catalog category. The flat list returned by `GET /v1/categories` is
/// tree-built client-side via `parentId` — there's no nested response
/// shape, by design, so a future deepening of the tree is a server-only
/// change.
public struct Category: Identifiable, Hashable, Sendable, Codable {
  public let id: UUID
  public let slug: String
  public let displayName: String
  public let parentId: UUID?
  public let displayOrder: Int
  public let iconKey: String?

  public init(
    id: UUID,
    slug: String,
    displayName: String,
    parentId: UUID?,
    displayOrder: Int,
    iconKey: String?
  ) {
    self.id = id
    self.slug = slug
    self.displayName = displayName
    self.parentId = parentId
    self.displayOrder = displayOrder
    self.iconKey = iconKey
  }
}
