import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// `@DependencyClient`-style abstraction over the favorites endpoints
/// (`/v1/me/favorites`). Reducers depend on this struct rather than
/// `APIClient` so TestStore tests substitute typed closures.
///
/// The four mutations resolve `Void` (the server replies 204 and they are
/// idempotent, so the client only cares that they didn't throw). `list` maps
/// the wire envelope into a `FavoritesPage`, silently dropping malformed rows.
public struct FavoritesAPIClient: Sendable {
  public var list: @Sendable (_ limit: Int, _ offset: Int) async throws -> FavoritesPage
  public var addDispensary: @Sendable (UUID) async throws -> Void
  public var removeDispensary: @Sendable (UUID) async throws -> Void
  public var addProduct: @Sendable (UUID) async throws -> Void
  public var removeProduct: @Sendable (UUID) async throws -> Void

  public init(
    list: @Sendable @escaping (_ limit: Int, _ offset: Int) async throws -> FavoritesPage,
    addDispensary: @Sendable @escaping (UUID) async throws -> Void,
    removeDispensary: @Sendable @escaping (UUID) async throws -> Void,
    addProduct: @Sendable @escaping (UUID) async throws -> Void,
    removeProduct: @Sendable @escaping (UUID) async throws -> Void
  ) {
    self.list = list
    self.addDispensary = addDispensary
    self.removeDispensary = removeDispensary
    self.addProduct = addProduct
    self.removeProduct = removeProduct
  }
}

public extension FavoritesAPIClient {
  /// Production binding. Each closure routes through the shared `APIClient`.
  static func live(apiClient: APIClient) -> FavoritesAPIClient {
    FavoritesAPIClient(
      list: { limit, offset in
        let dto = try await apiClient.send(FavoritesEndpoints.listFavorites(limit: limit, offset: offset))
        return dto.toDomain()
      },
      addDispensary: { id in
        _ = try await apiClient.send(FavoritesEndpoints.addDispensary(id: id))
      },
      removeDispensary: { id in
        _ = try await apiClient.send(FavoritesEndpoints.removeDispensary(id: id))
      },
      addProduct: { id in
        _ = try await apiClient.send(FavoritesEndpoints.addProduct(id: id))
      },
      removeProduct: { id in
        _ = try await apiClient.send(FavoritesEndpoints.removeProduct(id: id))
      }
    )
  }

  /// Test fixture that always throws.
  static let unimplemented = FavoritesAPIClient(
    list: { _, _ in throw FavoritesAPIError.unimplemented("list") },
    addDispensary: { _ in throw FavoritesAPIError.unimplemented("addDispensary") },
    removeDispensary: { _ in throw FavoritesAPIError.unimplemented("removeDispensary") },
    addProduct: { _ in throw FavoritesAPIError.unimplemented("addProduct") },
    removeProduct: { _ in throw FavoritesAPIError.unimplemented("removeProduct") }
  )
}

public enum FavoritesAPIError: Error, Sendable, Equatable {
  case unimplemented(String)
}

private enum FavoritesAPIClientKey: DependencyKey {
  static let liveValue: FavoritesAPIClient = .unimplemented
  static let testValue: FavoritesAPIClient = .unimplemented
}

public extension DependencyValues {
  var favoritesAPIClient: FavoritesAPIClient {
    get { self[FavoritesAPIClientKey.self] }
    set { self[FavoritesAPIClientKey.self] = newValue }
  }
}
