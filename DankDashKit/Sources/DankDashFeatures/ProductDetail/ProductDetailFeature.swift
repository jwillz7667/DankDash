import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Reducer for a single product detail screen. Loads the full product
/// (description, terpenes, lab results) from cache first, then refreshes
/// from network; surfaces the "Add to cart" delegate that the local
/// cart-draft reducer listens for; and orchestrates the COA PDF
/// download into a local file URL the SwiftUI view hands to
/// `QLPreviewController`.
///
/// State is constructed by the parent (Storefront or Search) which
/// already knows the listing-level fields needed to enqueue a cart row
/// (`priceCents`, `quantityAvailable`). Those flow through `State` as
/// `let` so they can't drift inside the reducer.
@Reducer
public struct ProductDetailFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable {
    public let productId: UUID
    public let listingId: UUID
    public let dispensaryId: UUID
    public let priceCents: Int
    public let maxAvailable: Int
    /// Fallback display name when `product` hasn't loaded yet. The
    /// parent passes this from the MenuItem so the navigation title
    /// renders immediately.
    public let productName: String
    public let brand: String
    /// The store this detail's listing belongs to, for the "Sold by"
    /// label. `nil` when the parent didn't resolve a store name (older
    /// call paths); the view simply omits the label.
    public let dispensaryName: String?

    public var product: Product?
    public var relatedProducts: [SearchProductResult]
    public var isLoading: Bool
    public var isShowingFromCache: Bool
    public var error: String?

    public var isCoaDownloading: Bool
    public var coaFileURL: URL?
    public var coaError: String?

    public init(
      productId: UUID,
      listingId: UUID,
      dispensaryId: UUID,
      priceCents: Int,
      maxAvailable: Int,
      productName: String,
      brand: String,
      dispensaryName: String? = nil,
      product: Product? = nil,
      relatedProducts: [SearchProductResult] = [],
      isLoading: Bool = false,
      isShowingFromCache: Bool = false,
      error: String? = nil,
      isCoaDownloading: Bool = false,
      coaFileURL: URL? = nil,
      coaError: String? = nil
    ) {
      self.productId = productId
      self.listingId = listingId
      self.dispensaryId = dispensaryId
      self.priceCents = priceCents
      self.maxAvailable = maxAvailable
      self.productName = productName
      self.brand = brand
      self.dispensaryName = dispensaryName
      self.product = product
      self.relatedProducts = relatedProducts
      self.isLoading = isLoading
      self.isShowingFromCache = isShowingFromCache
      self.error = error
      self.isCoaDownloading = isCoaDownloading
      self.coaFileURL = coaFileURL
      self.coaError = coaError
    }

    /// Convenience for the view: the newest lab result, if any.
    public var headlineLabResult: LabResult? {
      product?.labResults.first
    }

    public var canAddToCart: Bool {
      maxAvailable > 0
    }
  }

  public enum Action: Sendable, Equatable {
    case task
    case cacheLoaded(Product?)
    case fetchRequested
    case productResponse(Result<Product, ProductDetailError>)
    case relatedResponse(Result<[SearchProductResult], ProductDetailError>)
    case addToCartTapped
    case coaButtonTapped
    case coaDownloadResponse(Result<URL, ProductDetailError>)
    case coaDismissed
    case coaErrorDismissed
    case relatedTapped(productId: UUID)
    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Sendable, Equatable {
      /// Fired exactly once per Add-to-cart tap. The LocalCartDraft
      /// reducer listens for this and appends a line to the draft.
      case addedToCart(
        listingId: UUID,
        productId: UUID,
        productName: String,
        brand: String,
        priceCents: Int,
        maxAvailable: Int
      )
      /// Tapped a "related" tile. The Storefront/Browse layer routes
      /// the user to a fresh product detail for that product.
      case openRelatedProduct(productId: UUID)
    }
  }

  public enum ProductDetailError: Error, Sendable, Equatable {
    case transport
    case malformedPayload
    case notFound
    case unknown
  }

  @Dependency(\.catalogAPIClient) var api
  @Dependency(\.catalogCacheClient) var cache
  @Dependency(\.documentDownloadClient) var downloader
  @Dependency(\.cdnBaseURL) var cdnBaseURL

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .task:
        let productId = state.productId
        return .run { send in
          let cached = await cache.readProduct(productId)
          await send(.cacheLoaded(cached))
          await send(.fetchRequested)
        }

      case .cacheLoaded(let product):
        if let product {
          state.product = product
          state.isShowingFromCache = true
        }
        return .none

      case .fetchRequested:
        state.isLoading = true
        state.error = nil
        let productId = state.productId
        return .run { send in
          do {
            let product = try await api.getProduct(productId)
            await cache.writeProduct(productId, product)
            await send(.productResponse(.success(product)))
            do {
              let result = try await api.searchProducts(
                SearchProductsQuery(
                  categoryId: product.categoryId,
                  limit: 8
                )
              )
              let filtered = result.results.filter { $0.id != productId }
              let trimmed = Array(filtered.prefix(6))
              await send(.relatedResponse(.success(trimmed)))
            } catch let error as CatalogAPIError {
              switch error {
              case .malformedPayload: await send(.relatedResponse(.failure(.malformedPayload)))
              case .unimplemented: await send(.relatedResponse(.failure(.unknown)))
              }
            } catch {
              await send(.relatedResponse(.failure(.transport)))
            }
          } catch let error as CatalogAPIError {
            switch error {
            case .malformedPayload: await send(.productResponse(.failure(.malformedPayload)))
            case .unimplemented: await send(.productResponse(.failure(.unknown)))
            }
          } catch {
            await send(.productResponse(.failure(.transport)))
          }
        }

      case .productResponse(.success(let product)):
        state.product = product
        state.isLoading = false
        state.isShowingFromCache = false
        state.error = nil
        return .none

      case .productResponse(.failure(let error)):
        state.isLoading = false
        if state.product == nil {
          state.error = Self.userMessage(for: error)
        } else {
          state.isShowingFromCache = true
        }
        return .none

      case .relatedResponse(.success(let related)):
        state.relatedProducts = related
        return .none

      case .relatedResponse(.failure):
        // Related products are non-fatal — the detail screen renders
        // without the carousel if the call fails.
        return .none

      case .addToCartTapped:
        guard state.canAddToCart else { return .none }
        let listingId = state.listingId
        let productId = state.productId
        let productName = state.product?.name ?? state.productName
        let brand = state.product?.brand ?? state.brand
        let priceCents = state.priceCents
        let maxAvailable = state.maxAvailable
        return .send(.delegate(.addedToCart(
          listingId: listingId,
          productId: productId,
          productName: productName,
          brand: brand,
          priceCents: priceCents,
          maxAvailable: maxAvailable
        )))

      case .coaButtonTapped:
        guard let lab = state.product?.labResults.first,
              let key = lab.coaDocumentKey,
              !key.isEmpty
        else {
          state.coaError = "No certificate of analysis available."
          return .none
        }
        guard let remoteURL = Self.composeURL(base: cdnBaseURL, key: key) else {
          state.coaError = "Certificate location couldn't be resolved."
          return .none
        }
        state.isCoaDownloading = true
        state.coaError = nil
        return .run { send in
          do {
            let localURL = try await downloader.download(remoteURL)
            await send(.coaDownloadResponse(.success(localURL)))
          } catch {
            await send(.coaDownloadResponse(.failure(.transport)))
          }
        }

      case .coaDownloadResponse(.success(let url)):
        state.isCoaDownloading = false
        state.coaFileURL = url
        return .none

      case .coaDownloadResponse(.failure):
        state.isCoaDownloading = false
        state.coaError = "We couldn't download the certificate. Try again."
        return .none

      case .coaDismissed:
        state.coaFileURL = nil
        return .none

      case .coaErrorDismissed:
        state.coaError = nil
        return .none

      case .relatedTapped(let productId):
        return .send(.delegate(.openRelatedProduct(productId: productId)))

      case .delegate:
        return .none
      }
    }
  }

  static func userMessage(for error: ProductDetailError) -> String {
    switch error {
    case .transport: "We couldn't reach DankDash. Pull to retry."
    case .malformedPayload: "Something didn't look right in the product details."
    case .notFound: "This product isn't available anymore."
    case .unknown: "Something went wrong loading this product."
    }
  }

  /// Resolve an R2 object key into a fetchable URL. If `key` is already
  /// an absolute URL (rare — server returns raw keys) it's returned as
  /// is; otherwise the configured CDN base prefixes it.
  static func composeURL(base: URL?, key: String) -> URL? {
    if let absolute = URL(string: key), let scheme = absolute.scheme, !scheme.isEmpty {
      return absolute
    }
    return base?.appending(path: key)
  }
}
