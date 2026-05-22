import Foundation

/// `URLProtocol` subclass that lets tests script transport behaviour
/// against a real `URLSession` without going to the network. Register an
/// instance via `URLSessionConfiguration.ephemeral` + `protocolClasses`
/// and assign `handler` per-test.
///
/// Marked `final` and using static handler storage so the URLLoadingSystem
/// can instantiate it via the no-arg required init.
public final class URLProtocolMock: URLProtocol, @unchecked Sendable {
  public typealias Handler = @Sendable (URLRequest) throws -> (HTTPURLResponse, Data?)

  /// Global handler dispatched for every load. Tests set this in `setUp`
  /// and clear it in `tearDown`.
  nonisolated(unsafe) public static var handler: Handler?

  /// Records every request the system under test issues, in order. Tests
  /// use this to assert URL, method, headers, and body shape.
  nonisolated(unsafe) public static var capturedRequests: [URLRequest] = []

  public static func reset() {
    handler = nil
    capturedRequests = []
  }

  public override class func canInit(with request: URLRequest) -> Bool { true }
  public override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  public override func startLoading() {
    Self.capturedRequests.append(request)
    guard let handler = Self.handler else {
      client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
      return
    }
    do {
      let (response, data) = try handler(request)
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      if let data { client?.urlProtocol(self, didLoad: data) }
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  public override func stopLoading() {}
}

public extension URLSession {
  /// Convenience factory for tests: returns an ephemeral session that
  /// routes every request through `URLProtocolMock`.
  static func mocked() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [URLProtocolMock.self]
    return URLSession(configuration: configuration)
  }
}
