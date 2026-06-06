import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// `@DependencyClient`-style abstraction over the network calls our
/// reducers need. Keeping the surface narrow means TestStore tests
/// substitute typed closures rather than mocking URLSession or a full
/// APIClient. The implementation factory `.live(apiClient:)` wires
/// real network calls.
public struct AuthAPIClient: Sendable {
  public var login: @Sendable (LoginRequestDTO) async throws -> LoginResponseDTO
  public var register: @Sendable (RegisterRequestDTO) async throws -> RegisterResponseDTO
  public var verifyMfa: @Sendable (MfaVerifyRequestDTO) async throws -> MfaVerifyResponseDTO
  public var forgotPassword: @Sendable (ForgotPasswordRequestDTO) async throws -> EmptyResponse
  public var resetPassword: @Sendable (ResetPasswordRequestDTO) async throws -> EmptyResponse

  // The two reset closures default to the same "not stubbed" throw as
  // `.unimplemented`, so existing call sites that only exercise
  // login/register/verifyMfa stay source-compatible while any test that
  // touches the reset path fails loudly until it provides a real stub.
  public init(
    login: @Sendable @escaping (LoginRequestDTO) async throws -> LoginResponseDTO,
    register: @Sendable @escaping (RegisterRequestDTO) async throws -> RegisterResponseDTO,
    verifyMfa: @Sendable @escaping (MfaVerifyRequestDTO) async throws -> MfaVerifyResponseDTO,
    forgotPassword: @Sendable @escaping (ForgotPasswordRequestDTO) async throws -> EmptyResponse = {
      _ in throw APIError.configuration("AuthAPIClient.forgotPassword not stubbed")
    },
    resetPassword: @Sendable @escaping (ResetPasswordRequestDTO) async throws -> EmptyResponse = {
      _ in throw APIError.configuration("AuthAPIClient.resetPassword not stubbed")
    }
  ) {
    self.login = login
    self.register = register
    self.verifyMfa = verifyMfa
    self.forgotPassword = forgotPassword
    self.resetPassword = resetPassword
  }
}

public extension AuthAPIClient {
  /// Production binding. Each closure routes through the shared APIClient
  /// so the 401-refresh-retry dance applies uniformly.
  static func live(apiClient: APIClient) -> AuthAPIClient {
    AuthAPIClient(
      login: { request in
        try await apiClient.send(AuthEndpoints.login(request))
      },
      register: { request in
        try await apiClient.send(AuthEndpoints.register(request))
      },
      verifyMfa: { request in
        try await apiClient.send(AuthEndpoints.mfaVerify(request))
      },
      forgotPassword: { request in
        try await apiClient.send(AuthEndpoints.forgotPassword(request))
      },
      resetPassword: { request in
        try await apiClient.send(AuthEndpoints.resetPassword(request))
      }
    )
  }

  /// Test fixture that always throws — surfaces "this dependency wasn't
  /// stubbed" in TestStore tests as a clear error.
  static let unimplemented = AuthAPIClient(
    login: { _ in throw APIError.configuration("AuthAPIClient.login not stubbed") },
    register: { _ in throw APIError.configuration("AuthAPIClient.register not stubbed") },
    verifyMfa: { _ in throw APIError.configuration("AuthAPIClient.verifyMfa not stubbed") },
    forgotPassword: { _ in throw APIError.configuration("AuthAPIClient.forgotPassword not stubbed") },
    resetPassword: { _ in throw APIError.configuration("AuthAPIClient.resetPassword not stubbed") }
  )
}

private enum AuthAPIClientKey: DependencyKey {
  static let liveValue: AuthAPIClient = .unimplemented
  static let testValue: AuthAPIClient = .unimplemented
}

public extension DependencyValues {
  var authAPIClient: AuthAPIClient {
    get { self[AuthAPIClientKey.self] }
    set { self[AuthAPIClientKey.self] = newValue }
  }
}
