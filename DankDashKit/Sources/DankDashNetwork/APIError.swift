import Foundation

/// Typed error surface for every API call. Callers branch on these cases
/// instead of inspecting `NSError` codes; the underlying transport /
/// decoding error is preserved as `cause` when we have one.
public enum APIError: Error, Sendable {
  /// URLSession failed before the server replied (DNS, timeout, TLS).
  case transport(Error)
  /// Server returned a non-2xx with a parseable envelope.
  case server(status: Int, envelope: ErrorEnvelope)
  /// Server returned a non-2xx but the body wasn't the standard envelope.
  case unexpectedStatus(status: Int, data: Data)
  /// 2xx response but the body didn't decode into the expected DTO.
  case decoding(Error)
  /// 401 after the refresh attempt was either skipped or itself failed.
  /// The caller should clear tokens and route to login.
  case unauthorized
  /// We're missing a refresh token we need to drive the auth dance.
  case noRefreshToken
  /// A precondition for the request (e.g. base URL) wasn't met.
  case configuration(String)
}

extension APIError: CustomStringConvertible {
  public var description: String {
    switch self {
    case .transport(let error): "transport(\(error))"
    case .server(let status, let envelope): "server[\(status)] \(envelope.error.code): \(envelope.error.message)"
    case .unexpectedStatus(let status, _): "unexpectedStatus(\(status))"
    case .decoding(let error): "decoding(\(error))"
    case .unauthorized: "unauthorized"
    case .noRefreshToken: "noRefreshToken"
    case .configuration(let message): "configuration: \(message)"
    }
  }
}
