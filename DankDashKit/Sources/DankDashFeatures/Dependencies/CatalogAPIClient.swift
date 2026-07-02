import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// `@DependencyClient`-style abstraction over the catalog endpoints
/// (dispensary feed, single dispensary, menu, product, categories,
/// search). Reducers depend on this struct rather than `APIClient`
/// directly so TestStore tests can substitute typed closures.
public struct CatalogAPIClient: Sendable {
  public var listDispensaries: @Sendable (Coordinate?) async throws -> [Dispensary]
  public var getDispensary: @Sendable (UUID) async throws -> Dispensary
  public var getMenu: @Sendable (UUID) async throws -> (dispensaryId: UUID, items: [MenuItem])
  public var getProduct: @Sendable (UUID) async throws -> Product
  /// The stores actively carrying a product, in-stock, price-ascending.
  /// Resolves the listing context a search hit lacks so it can be added to
  /// the cart.
  public var getProductListings: @Sendable (UUID) async throws -> [ProductListing]
  public var listCategories: @Sendable () async throws -> [DankDashDomain.Category]
  public var searchProducts: @Sendable (SearchProductsQuery) async throws -> SearchProductsResult

  public init(
    listDispensaries: @Sendable @escaping (Coordinate?) async throws -> [Dispensary],
    getDispensary: @Sendable @escaping (UUID) async throws -> Dispensary,
    getMenu: @Sendable @escaping (UUID) async throws -> (dispensaryId: UUID, items: [MenuItem]),
    getProduct: @Sendable @escaping (UUID) async throws -> Product,
    getProductListings: @Sendable @escaping (UUID) async throws -> [ProductListing],
    listCategories: @Sendable @escaping () async throws -> [DankDashDomain.Category],
    searchProducts: @Sendable @escaping (SearchProductsQuery) async throws -> SearchProductsResult
  ) {
    self.listDispensaries = listDispensaries
    self.getDispensary = getDispensary
    self.getMenu = getMenu
    self.getProduct = getProduct
    self.getProductListings = getProductListings
    self.listCategories = listCategories
    self.searchProducts = searchProducts
  }
}

/// Domain-shaped projection of the search response. The DTO surfaces a
/// nested facets object; the feature layer wants the lists at the top
/// level so reducers can pattern-match without reaching into DTOs.
public struct SearchProductsResult: Sendable, Equatable {
  public let results: [SearchProductResult]
  public let categoryFacets: [SearchCategoryFacet]
  public let strainTypeFacets: [SearchStrainTypeFacet]
  public let page: SearchPage

  public init(
    results: [SearchProductResult],
    categoryFacets: [SearchCategoryFacet],
    strainTypeFacets: [SearchStrainTypeFacet],
    page: SearchPage
  ) {
    self.results = results
    self.categoryFacets = categoryFacets
    self.strainTypeFacets = strainTypeFacets
    self.page = page
  }
}

public extension CatalogAPIClient {
  /// Production binding. Each closure routes through the shared
  /// `APIClient` so the bearer-injection / 401-refresh behavior applies
  /// uniformly. Failable `.toDomain()` projections throw `CatalogAPIError`
  /// when the server returns a structurally invalid payload.
  static func live(apiClient: APIClient) -> CatalogAPIClient {
    CatalogAPIClient(
      listDispensaries: { coordinate in
        let coord = coordinate.map { (latitude: $0.latitude, longitude: $0.longitude) }
        let dto = try await apiClient.send(DispensariesEndpoints.listDispensaries(near: coord))
        return dto.toDomain()
      },
      getDispensary: { id in
        let dto = try await apiClient.send(DispensariesEndpoints.getDispensary(id: id))
        guard let dispensary = dto.toDomain() else { throw CatalogAPIError.malformedPayload("Dispensary") }
        return dispensary
      },
      getMenu: { dispensaryId in
        let dto = try await apiClient.send(DispensariesEndpoints.getMenu(dispensaryId: dispensaryId))
        guard let projection = dto.toDomain() else { throw CatalogAPIError.malformedPayload("Menu") }
        return projection
      },
      getProduct: { id in
        let dto = try await apiClient.send(ProductsEndpoints.getProduct(id: id))
        guard let product = dto.toDomain() else { throw CatalogAPIError.malformedPayload("Product") }
        return product
      },
      getProductListings: { id in
        let dto = try await apiClient.send(ProductsEndpoints.getProductListings(id: id))
        return dto.toDomain()
      },
      listCategories: {
        let dto = try await apiClient.send(CategoriesEndpoints.listCategories())
        return dto.toDomain()
      },
      searchProducts: { query in
        let dto = try await apiClient.send(SearchEndpoints.search(query))
        let projection = dto.toDomain()
        return SearchProductsResult(
          results: projection.results,
          categoryFacets: projection.categoryFacets,
          strainTypeFacets: projection.strainTypeFacets,
          page: projection.page
        )
      }
    )
  }

  /// Test fixture that always throws — surfaces "this dependency wasn't
  /// stubbed" in TestStore tests as a clear error.
  static let unimplemented = CatalogAPIClient(
    listDispensaries: { _ in throw CatalogAPIError.unimplemented("listDispensaries") },
    getDispensary: { _ in throw CatalogAPIError.unimplemented("getDispensary") },
    getMenu: { _ in throw CatalogAPIError.unimplemented("getMenu") },
    getProduct: { _ in throw CatalogAPIError.unimplemented("getProduct") },
    getProductListings: { _ in throw CatalogAPIError.unimplemented("getProductListings") },
    listCategories: { throw CatalogAPIError.unimplemented("listCategories") },
    searchProducts: { _ in throw CatalogAPIError.unimplemented("searchProducts") }
  )
}

public enum CatalogAPIError: Error, Sendable, Equatable {
  case malformedPayload(String)
  case unimplemented(String)
}

private enum CatalogAPIClientKey: DependencyKey {
  static let liveValue: CatalogAPIClient = .unimplemented
  static let testValue: CatalogAPIClient = .unimplemented
}

public extension DependencyValues {
  var catalogAPIClient: CatalogAPIClient {
    get { self[CatalogAPIClientKey.self] }
    set { self[CatalogAPIClientKey.self] = newValue }
  }
}
