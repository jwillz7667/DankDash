import Foundation
import DankDashDomain

/// Response shape for `POST /v1/identity/kyc/start` — mirror of
/// `KycStartResponseSchema` in
/// `apps/api/src/modules/identity/dto/kyc.dto.ts`. The endpoint takes no
/// request body (it operates on the authenticated user), so there is no
/// paired request DTO.
///
/// Note the wire field is `inquiryUrl`, not `hostedFlowUrl` — the server
/// renames the service-internal field on the way out. The URL is fully
/// qualified server-side; the client never templates Persona URLs.
public struct KYCStartResponseDTO: Decodable, Sendable, Equatable {
  public let inquiryId: String
  public let inquiryUrl: String

  public init(inquiryId: String, inquiryUrl: String) {
    self.inquiryId = inquiryId
    self.inquiryUrl = inquiryUrl
  }
}

public extension KYCStartResponseDTO {
  /// Lossy projection — returns nil on a malformed URL or an empty id.
  /// The caller surfaces the failure as "we couldn't start verification,
  /// try again" rather than handing Safari a bad URL.
  func toDomain() -> KYCInquiry? {
    guard !inquiryId.isEmpty else { return nil }
    guard let parsedURL = URL(string: inquiryUrl), parsedURL.scheme != nil else { return nil }
    return KYCInquiry(inquiryId: inquiryId, inquiryURL: parsedURL)
  }
}
