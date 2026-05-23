import Foundation

/// Lightweight wrapper around URLSession that owns auth-header injection
/// and the single-shot 401-refresh-retry dance. Designed so feature
/// reducers can be tested by stubbing `AuthInterceptor` and
/// `URLSessionProtocol` without touching the network.
///
/// **No retries beyond the auth refresh.** Other transient failures bubble
/// to the caller; TCA reducers are the natural place to encode "retry on
/// failure" UX policy.
public actor APIClient {
  private let baseURL: URL
  private let session: URLSessionProtocol
  private let interceptor: AuthInterceptor
  private let encoder: JSONEncoder
  private let decoder: JSONDecoder
  private var isRefreshing: Bool = false

  public init(
    baseURL: URL,
    session: URLSessionProtocol,
    interceptor: AuthInterceptor
  ) {
    self.baseURL = baseURL
    self.session = session
    self.interceptor = interceptor
    self.encoder = APIClient.makeEncoder()
    self.decoder = APIClient.makeDecoder()
  }

  /// Convenience initializer that uses `URLSession.shared`. The actor
  /// wrapping makes `URLSession` callable across actors.
  public init(baseURL: URL, interceptor: AuthInterceptor) {
    self.init(
      baseURL: baseURL,
      session: URLSession.shared as URLSessionProtocol,
      interceptor: interceptor
    )
  }

  // MARK: - Public surface

  /// Issues a request expecting a Decodable body. Authenticated calls
  /// (i.e. `endpoint.requiresAuth == true`) get the bearer header
  /// applied, and a single 401 triggers a refresh + retry.
  public func send<Response: Decodable & Sendable>(
    _ endpoint: Endpoint<Response>
  ) async throws -> Response {
    let data = try await sendForData(endpoint, allowRetry: true)
    return try decode(Response.self, from: data)
  }

  /// Issues a request that has no body (e.g. logout). Returns when the
  /// server replies with any 2xx.
  public func sendIgnoringResponse(_ endpoint: Endpoint<Void>) async throws {
    _ = try await sendForData(endpoint, allowRetry: true)
  }

  // MARK: - Core send pipeline

  private func sendForData<Response>(
    _ endpoint: Endpoint<Response>,
    allowRetry: Bool
  ) async throws -> Data {
    var request = try buildURLRequest(for: endpoint)
    if endpoint.requiresAuth {
      let accessToken = try await interceptor.accessToken()
      request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    }

    let (data, response) = try await transport(request)
    guard let httpResponse = response as? HTTPURLResponse else {
      throw APIError.transport(
        URLError(.badServerResponse, userInfo: [NSLocalizedDescriptionKey: "non-HTTP response"])
      )
    }

    let status = httpResponse.statusCode
    if (200..<300).contains(status) { return data }

    if status == 401, endpoint.requiresAuth, allowRetry {
      try await performRefresh()
      return try await sendForData(endpoint, allowRetry: false)
    }
    if status == 401 {
      // The refresh attempt itself returned 401, or the call refuses to
      // refresh — caller should clear tokens and route to login.
      await interceptor.clearTokens()
      throw APIError.unauthorized
    }

    if let envelope = try? decoder.decode(ErrorEnvelope.self, from: data) {
      throw APIError.server(status: status, envelope: envelope)
    }
    throw APIError.unexpectedStatus(status: status, data: data)
  }

  private func transport(_ request: URLRequest) async throws -> (Data, URLResponse) {
    do {
      return try await session.data(for: request)
    } catch {
      throw APIError.transport(error)
    }
  }

  // MARK: - Refresh dance

  /// One refresh in flight at a time per actor instance. Concurrent
  /// callers piggy-back on the same refresh by reading the post-refresh
  /// access token from the interceptor.
  private func performRefresh() async throws {
    if isRefreshing {
      while isRefreshing { try await Task.sleep(nanoseconds: 10_000_000) }
      return
    }
    isRefreshing = true
    defer { isRefreshing = false }

    guard let refreshToken = await interceptor.refreshToken() else {
      throw APIError.noRefreshToken
    }

    let body = RefreshRequestDTO(refreshToken: refreshToken)
    var request = URLRequest(url: baseURL.appending(path: "v1/auth/refresh"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try encoder.encode(body)

    let (data, response) = try await transport(request)
    guard let http = response as? HTTPURLResponse else {
      throw APIError.transport(URLError(.badServerResponse))
    }
    if http.statusCode == 401 {
      await interceptor.clearTokens()
      throw APIError.unauthorized
    }
    guard (200..<300).contains(http.statusCode) else {
      if let envelope = try? decoder.decode(ErrorEnvelope.self, from: data) {
        throw APIError.server(status: http.statusCode, envelope: envelope)
      }
      throw APIError.unexpectedStatus(status: http.statusCode, data: data)
    }

    let refreshed = try decode(RefreshResponseDTO.self, from: data)
    await interceptor.persist(tokens: refreshed.tokens)
  }

  // MARK: - Encoding

  private func buildURLRequest<Response>(for endpoint: Endpoint<Response>) throws -> URLRequest {
    var components = URLComponents(
      url: baseURL.appending(path: endpoint.path),
      resolvingAgainstBaseURL: false
    )
    if !endpoint.queryItems.isEmpty {
      components?.queryItems = endpoint.queryItems
    }
    guard let url = components?.url else {
      throw APIError.configuration("invalid URL for \(endpoint.path)")
    }
    var request = URLRequest(url: url)
    request.httpMethod = endpoint.method.rawValue
    for (header, value) in endpoint.headers {
      request.setValue(value, forHTTPHeaderField: header)
    }
    if let bodyEncodable = endpoint.body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try bodyEncodable.encode(using: encoder)
    }
    return request
  }

  private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
    if T.self == Data.self, let data = data as? T { return data }
    do {
      return try decoder.decode(T.self, from: data)
    } catch {
      throw APIError.decoding(error)
    }
  }

  // MARK: - Coders

  private static func makeEncoder() -> JSONEncoder {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    return encoder
  }

  private static func makeDecoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return decoder
  }
}

/// Subset of URLSession we depend on; tests substitute `URLProtocolMock`
/// to control transport behavior.
public protocol URLSessionProtocol: Sendable {
  func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: URLSessionProtocol {}
