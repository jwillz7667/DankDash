import Foundation
import DankDashDomain

/// Wire shape for `CategoryResponseSchema`. `parentId` lets the iOS
/// client tree-build the catalog client-side via repeated indexing.
public struct CategoryDTO: Decodable, Sendable, Equatable {
  public let id: String
  public let slug: String
  public let displayName: String
  public let parentId: String?
  public let displayOrder: Int
  public let iconKey: String?

  public init(
    id: String,
    slug: String,
    displayName: String,
    parentId: String?,
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

public extension CategoryDTO {
  func toDomain() -> DankDashDomain.Category? {
    guard let parsedID = CatalogWire.parseUUID(id) else { return nil }
    let parsedParentID: UUID?
    if let parentId {
      guard let parsed = CatalogWire.parseUUID(parentId) else { return nil }
      parsedParentID = parsed
    } else {
      parsedParentID = nil
    }
    return DankDashDomain.Category(
      id: parsedID,
      slug: slug,
      displayName: displayName,
      parentId: parsedParentID,
      displayOrder: displayOrder,
      iconKey: iconKey
    )
  }
}

/// Wire envelope for `GET /v1/categories`.
public struct CategoryListResponseDTO: Decodable, Sendable, Equatable {
  public let categories: [CategoryDTO]

  public init(categories: [CategoryDTO]) {
    self.categories = categories
  }

  public func toDomain() -> [DankDashDomain.Category] {
    categories.compactMap { $0.toDomain() }
  }
}
