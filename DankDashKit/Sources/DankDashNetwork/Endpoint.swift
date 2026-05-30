import Foundation

public enum HTTPMethod: String, Sendable {
  case GET, POST, PATCH, PUT, DELETE
}

/// Describes one API call without committing to a response type at the
/// call site — `Response` is the type the client should decode the body
/// into. `Response == Void` for fire-and-forget endpoints.
public struct Endpoint<Response>: Sendable {
  public let method: HTTPMethod
  public let path: String
  public let queryItems: [URLQueryItem]
  public let headers: [String: String]
  public let body: AnyEncodableBody?
  public let requiresAuth: Bool

  public init(
    method: HTTPMethod,
    path: String,
    queryItems: [URLQueryItem] = [],
    headers: [String: String] = [:],
    body: AnyEncodableBody? = nil,
    requiresAuth: Bool = false
  ) {
    self.method = method
    self.path = path
    self.queryItems = queryItems
    self.headers = headers
    self.body = body
    self.requiresAuth = requiresAuth
  }
}

/// Type-erased Encodable wrapper so `Endpoint` can hold a body without
/// becoming generic over the request type.
public struct AnyEncodableBody: Sendable {
  private let _encode: @Sendable (JSONEncoder) throws -> Data

  public init<T: Encodable & Sendable>(_ value: T) {
    self._encode = { encoder in try encoder.encode(value) }
  }

  public func encode(using encoder: JSONEncoder) throws -> Data {
    try _encode(encoder)
  }
}
