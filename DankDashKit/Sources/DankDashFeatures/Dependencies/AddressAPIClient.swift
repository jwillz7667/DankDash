import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// `@DependencyClient`-style abstraction over the addresses endpoints
/// (`GET/POST/PATCH /v1/addresses`). Reducers depend on this struct
/// rather than `APIClient` so TestStore tests substitute typed closures.
///
/// `listAddresses` silently drops malformed rows (one bad row shouldn't
/// hide the entire picker). `createAddress` / `patchAddress` / `editAddress`
/// throw `AddressAPIError.malformedPayload` when the single-row projection
/// fails — those call sites need the freshly-saved row to update reducer
/// state. `deleteAddress` resolves `Void` (the server replies 204).
public struct AddressAPIClient: Sendable {
  public var listAddresses: @Sendable () async throws -> [UserAddress]
  public var createAddress: @Sendable (CreateAddressRequestDTO) async throws -> UserAddress
  public var patchAddress: @Sendable (UUID, PatchAddressRequestDTO) async throws -> UserAddress
  public var editAddress: @Sendable (UUID, EditAddressRequestDTO) async throws -> UserAddress
  public var deleteAddress: @Sendable (UUID) async throws -> Void

  public init(
    listAddresses: @Sendable @escaping () async throws -> [UserAddress],
    createAddress: @Sendable @escaping (CreateAddressRequestDTO) async throws -> UserAddress,
    patchAddress: @Sendable @escaping (UUID, PatchAddressRequestDTO) async throws -> UserAddress,
    editAddress: @Sendable @escaping (UUID, EditAddressRequestDTO) async throws -> UserAddress,
    deleteAddress: @Sendable @escaping (UUID) async throws -> Void
  ) {
    self.listAddresses = listAddresses
    self.createAddress = createAddress
    self.patchAddress = patchAddress
    self.editAddress = editAddress
    self.deleteAddress = deleteAddress
  }
}

public extension AddressAPIClient {
  /// Production binding. Each closure routes through the shared
  /// `APIClient`.
  static func live(apiClient: APIClient) -> AddressAPIClient {
    AddressAPIClient(
      listAddresses: {
        let dto = try await apiClient.send(AddressesEndpoints.listAddresses())
        return dto.toDomain()
      },
      createAddress: { body in
        let dto = try await apiClient.send(AddressesEndpoints.createAddress(body: body))
        guard let address = dto.toDomain() else {
          throw AddressAPIError.malformedPayload("UserAddress")
        }
        return address
      },
      patchAddress: { id, body in
        let dto = try await apiClient.send(AddressesEndpoints.patchAddress(id: id, body: body))
        guard let address = dto.toDomain() else {
          throw AddressAPIError.malformedPayload("UserAddress")
        }
        return address
      },
      editAddress: { id, body in
        let dto = try await apiClient.send(AddressesEndpoints.editAddress(id: id, body: body))
        guard let address = dto.toDomain() else {
          throw AddressAPIError.malformedPayload("UserAddress")
        }
        return address
      },
      deleteAddress: { id in
        // 204 No Content → EmptyResponse; we only care that it didn't throw.
        _ = try await apiClient.send(AddressesEndpoints.deleteAddress(id: id))
      }
    )
  }

  /// Test fixture that always throws.
  static let unimplemented = AddressAPIClient(
    listAddresses: { throw AddressAPIError.unimplemented("listAddresses") },
    createAddress: { _ in throw AddressAPIError.unimplemented("createAddress") },
    patchAddress: { _, _ in throw AddressAPIError.unimplemented("patchAddress") },
    editAddress: { _, _ in throw AddressAPIError.unimplemented("editAddress") },
    deleteAddress: { _ in throw AddressAPIError.unimplemented("deleteAddress") }
  )
}

public enum AddressAPIError: Error, Sendable, Equatable {
  case malformedPayload(String)
  case unimplemented(String)
}

private enum AddressAPIClientKey: DependencyKey {
  static let liveValue: AddressAPIClient = .unimplemented
  static let testValue: AddressAPIClient = .unimplemented
}

public extension DependencyValues {
  var addressAPIClient: AddressAPIClient {
    get { self[AddressAPIClientKey.self] }
    set { self[AddressAPIClientKey.self] = newValue }
  }
}
