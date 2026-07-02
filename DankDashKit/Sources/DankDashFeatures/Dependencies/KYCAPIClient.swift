import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Closure-backed dependency over the consumer KYC surface
/// (`POST /v1/identity/kyc/start`). Sole purpose: mint a Persona inquiry
/// and hand back the hosted-flow URL the ``KYCFeature`` opens in an
/// `SFSafariViewController`.
///
/// The reducer never composes Persona URLs and never sees the webhook —
/// verification state is read back off `GET /v1/me` (via
/// ``MeAPIClient``) once the hosted flow returns. This client is the only
/// thing that starts an inquiry, so "restart verification" is just a
/// second call (Persona mints a fresh inquiry each time).
///
/// The live binding is wired in `AppEnvironment.prepareDependencies`;
/// `liveValue` defaults to ``unimplemented`` because the real binding
/// needs the shared `APIClient`, which only exists at app boot.
public struct KYCAPIClient: Sendable {
  public var startInquiry: @Sendable () async throws -> KYCInquiry

  public init(
    startInquiry: @Sendable @escaping () async throws -> KYCInquiry
  ) {
    self.startInquiry = startInquiry
  }
}

public extension KYCAPIClient {
  /// Production binding.
  static func live(apiClient: APIClient) -> KYCAPIClient {
    KYCAPIClient(
      startInquiry: {
        let dto = try await apiClient.send(KYCEndpoints.start())
        guard let inquiry = dto.toDomain() else {
          throw KYCAPIError.malformedPayload("KYCInquiry")
        }
        return inquiry
      }
    )
  }

  /// Test fixture that always throws.
  static let unimplemented = KYCAPIClient(
    startInquiry: {
      throw KYCAPIError.unimplemented("startInquiry")
    }
  )
}

public enum KYCAPIError: Error, Sendable, Equatable {
  case malformedPayload(String)
  case unimplemented(String)
}

private enum KYCAPIClientKey: DependencyKey {
  static let liveValue: KYCAPIClient = .unimplemented
  static let testValue: KYCAPIClient = .unimplemented
}

public extension DependencyValues {
  var kycAPIClient: KYCAPIClient {
    get { self[KYCAPIClientKey.self] }
    set { self[KYCAPIClientKey.self] = newValue }
  }
}
