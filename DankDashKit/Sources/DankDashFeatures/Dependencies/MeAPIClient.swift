import Foundation
import ComposableArchitecture
import DankDashNetwork

/// Closure-backed dependency for the authenticated-user surface
/// (`/v1/me`). Reducers consume it via `@Dependency(\.meAPIClient)`; the
/// live binding is wired in `AppEnvironment.prepareDependencies`.
public struct MeAPIClient: Sendable {
  public var getProfile: @Sendable () async throws -> UserSummaryDTO
  public var updateProfile: @Sendable (UpdateMeRequestDTO) async throws -> UserSummaryDTO
  /// Irreversibly deletes the signed-in account. Resolves on success (the
  /// server's `{ deletedAt }` ack is discarded); throws on any non-2xx so the
  /// caller keeps the user signed in and surfaces the error (e.g. a 409 when
  /// an order is still in flight).
  public var deleteAccount: @Sendable () async throws -> Void

  public init(
    getProfile: @Sendable @escaping () async throws -> UserSummaryDTO,
    updateProfile: @Sendable @escaping (UpdateMeRequestDTO) async throws -> UserSummaryDTO,
    deleteAccount: @Sendable @escaping () async throws -> Void
  ) {
    self.getProfile = getProfile
    self.updateProfile = updateProfile
    self.deleteAccount = deleteAccount
  }
}

public extension MeAPIClient {
  static func live(apiClient: APIClient) -> MeAPIClient {
    MeAPIClient(
      getProfile: { try await apiClient.send(MeEndpoints.current()) },
      updateProfile: { body in try await apiClient.send(MeEndpoints.updateProfile(body: body)) },
      deleteAccount: { _ = try await apiClient.send(MeEndpoints.deleteAccount()) }
    )
  }

  static let unimplemented = MeAPIClient(
    getProfile: { throw MeAPIError.unimplemented("getProfile") },
    updateProfile: { _ in throw MeAPIError.unimplemented("updateProfile") },
    deleteAccount: { throw MeAPIError.unimplemented("deleteAccount") }
  )
}

public enum MeAPIError: Error, Sendable, Equatable {
  case unimplemented(String)
}

private enum MeAPIClientKey: DependencyKey {
  static let liveValue: MeAPIClient = .unimplemented
  static let testValue: MeAPIClient = .unimplemented
}

public extension DependencyValues {
  var meAPIClient: MeAPIClient {
    get { self[MeAPIClientKey.self] }
    set { self[MeAPIClientKey.self] = newValue }
  }
}
