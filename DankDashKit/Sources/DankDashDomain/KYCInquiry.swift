import Foundation

/// Persona hosted-flow handle returned by `POST /v1/identity/kyc/start`.
/// The consumer app opens `inquiryURL` in an `SFSafariViewController`;
/// Persona's webhook — not the client — is the authority on the outcome,
/// so iOS only needs the URL to launch the flow and the id for support
/// diagnostics ("which inquiry did this session run against?").
///
/// `inquiryURL` is composed server-side and fully qualified (the client
/// never templates Persona URLs), mirroring the checkout-handoff
/// `exchangeUrl` contract. Restarting verification mints a *new* inquiry
/// server-side, so this value is single-use per attempt — the reducer
/// discards it once Safari is dismissed and fetches a fresh one on retry.
public struct KYCInquiry: Hashable, Sendable, Codable {
  public let inquiryId: String
  public let inquiryURL: URL

  public init(inquiryId: String, inquiryURL: URL) {
    self.inquiryId = inquiryId
    self.inquiryURL = inquiryURL
  }
}
