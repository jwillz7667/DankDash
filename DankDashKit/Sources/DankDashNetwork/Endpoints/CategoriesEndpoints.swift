import Foundation

public enum CategoriesEndpoints {
  /// `GET /v1/categories`. Flat list ordered by `display_order`. The
  /// client tree-builds via `parentId`.
  public static func listCategories() -> Endpoint<CategoryListResponseDTO> {
    Endpoint(
      method: .GET,
      path: "v1/categories",
      requiresAuth: false
    )
  }
}
