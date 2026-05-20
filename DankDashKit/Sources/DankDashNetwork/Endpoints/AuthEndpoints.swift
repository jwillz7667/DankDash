import Foundation

/// Auth endpoint catalog. Each static method returns an `Endpoint` typed
/// to the response it expects, so call sites don't have to know the
/// path / method / requiresAuth flag in isolation.
public enum AuthEndpoints {
  public static func login(_ body: LoginRequestDTO) -> Endpoint<LoginResponseDTO> {
    Endpoint(
      method: .POST,
      path: "v1/auth/login",
      body: AnyEncodableBody(body),
      requiresAuth: false
    )
  }

  public static func register(_ body: RegisterRequestDTO) -> Endpoint<RegisterResponseDTO> {
    Endpoint(
      method: .POST,
      path: "v1/auth/register",
      body: AnyEncodableBody(body),
      requiresAuth: false
    )
  }

  public static func mfaVerify(_ body: MfaVerifyRequestDTO) -> Endpoint<MfaVerifyResponseDTO> {
    Endpoint(
      method: .POST,
      path: "v1/auth/mfa/verify",
      body: AnyEncodableBody(body),
      requiresAuth: false
    )
  }

  /// Refresh is special — APIClient drives it internally rather than via
  /// the public Endpoint pipeline, so we don't expose it on
  /// `AuthEndpoints`. Logout is authenticated.
  public static func logout() -> Endpoint<EmptyResponse> {
    Endpoint(
      method: .POST,
      path: "v1/auth/logout",
      requiresAuth: true
    )
  }
}

/// Decodable placeholder for endpoints that return an empty body (2xx
/// with `{}` or no content).
public struct EmptyResponse: Decodable, Sendable, Equatable {
  public init() {}
  public init(from decoder: Decoder) throws { self.init() }
}
