import Foundation
import DankDashDomain

/// Wire shape for `PaymentMethodResponseSchema`. Decoded stringly to mirror
/// the JSON exactly (camelCase keys, no snake-case conversion on the shared
/// decoder); `toDomain()` is the only place that validates the UUID, the
/// enum members, and the timestamps. An unknown `type` / `status` (a newer
/// server enum the app doesn't know yet) projects to `nil` and the row is
/// dropped by the list's `compactMap` rather than crashing the screen.
public struct PaymentMethodResponseDTO: Decodable, Sendable, Equatable {
  public let id: String
  public let type: String
  public let aeropayPaymentMethodRef: String?
  public let bankName: String?
  public let last4: String?
  public let isDefault: Bool
  public let status: String
  public let createdAt: String
  public let updatedAt: String

  public init(
    id: String,
    type: String,
    aeropayPaymentMethodRef: String?,
    bankName: String?,
    last4: String?,
    isDefault: Bool,
    status: String,
    createdAt: String,
    updatedAt: String
  ) {
    self.id = id
    self.type = type
    self.aeropayPaymentMethodRef = aeropayPaymentMethodRef
    self.bankName = bankName
    self.last4 = last4
    self.isDefault = isDefault
    self.status = status
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }
}

public extension PaymentMethodResponseDTO {
  /// Lossy projection. Returns `nil` on a malformed UUID / timestamp or an
  /// unrecognized `type` / `status`.
  func toDomain() -> PaymentMethod? {
    guard let parsedID = CatalogWire.parseUUID(id) else { return nil }
    guard let parsedType = PaymentMethodType(rawValue: type) else { return nil }
    guard let parsedStatus = PaymentMethodStatus(rawValue: status) else { return nil }
    guard let parsedCreated = CatalogWire.parseISO8601(createdAt) else { return nil }
    guard let parsedUpdated = CatalogWire.parseISO8601(updatedAt) else { return nil }
    return PaymentMethod(
      id: parsedID,
      type: parsedType,
      aeropayPaymentMethodRef: aeropayPaymentMethodRef,
      bankName: bankName,
      last4: last4,
      isDefault: isDefault,
      status: parsedStatus,
      createdAt: parsedCreated,
      updatedAt: parsedUpdated
    )
  }
}

/// Wire envelope for `GET /v1/payment-methods`.
public struct ListPaymentMethodsResponseDTO: Decodable, Sendable, Equatable {
  public let paymentMethods: [PaymentMethodResponseDTO]

  public init(paymentMethods: [PaymentMethodResponseDTO]) {
    self.paymentMethods = paymentMethods
  }

  /// Projects to Domain, silently dropping any malformed row.
  public func toDomain() -> [PaymentMethod] {
    paymentMethods.compactMap { $0.toDomain() }
  }
}

/// Body for `POST /v1/payment-methods/aeropay/link`. Mirrors
/// `LinkAeropayRequestSchema`. `returnUrl` must be an absolute URL — the
/// composition root supplies it (see `AppEnvironment`), keeping the reducer
/// agnostic about the app's web host.
public struct LinkAeropayRequestDTO: Encodable, Sendable, Equatable {
  public let returnUrl: String

  public init(returnUrl: String) {
    self.returnUrl = returnUrl
  }
}

/// Wire shape for the `link` member of the link-session response.
public struct AeropayLinkSessionResponseDTO: Decodable, Sendable, Equatable {
  public let id: String
  public let hostedUrl: String
  public let expiresAt: String

  public init(id: String, hostedUrl: String, expiresAt: String) {
    self.id = id
    self.hostedUrl = hostedUrl
    self.expiresAt = expiresAt
  }

  /// `nil` if the hosted URL isn't a valid absolute URL or the expiry
  /// timestamp is malformed — the caller treats that as a link failure.
  public func toDomain() -> AeropayLinkSession? {
    guard let url = URL(string: hostedUrl), url.scheme != nil else { return nil }
    guard let expires = CatalogWire.parseISO8601(expiresAt) else { return nil }
    return AeropayLinkSession(id: id, hostedUrl: url, expiresAt: expires)
  }
}

/// Wire envelope for `POST /v1/payment-methods/aeropay/link`:
/// `{ paymentMethod, link }`. The iOS flow only needs `link.hostedUrl` to
/// open Safari (it re-lists after the sheet closes, so the pending
/// `paymentMethod` here is informational), but both are decoded to match
/// the contract.
public struct LinkAeropayResponseDTO: Decodable, Sendable, Equatable {
  public let paymentMethod: PaymentMethodResponseDTO
  public let link: AeropayLinkSessionResponseDTO

  public init(paymentMethod: PaymentMethodResponseDTO, link: AeropayLinkSessionResponseDTO) {
    self.paymentMethod = paymentMethod
    self.link = link
  }
}

/// Body for `PATCH /v1/payment-methods/:id`. The server validates
/// `isDefault` as a `z.literal(true)` — the only mutation this route
/// performs is promotion to default — so this DTO hardcodes `true` and
/// exposes no way to send `false`.
public struct SetDefaultPaymentMethodRequestDTO: Encodable, Sendable, Equatable {
  public let isDefault: Bool

  public init() {
    self.isDefault = true
  }
}

/// Wire envelope for `PATCH /v1/payment-methods/:id`:
/// `{ paymentMethod }` (the promoted row). The client still re-lists to
/// pick up the demoted previous default.
public struct PaymentMethodEnvelopeResponseDTO: Decodable, Sendable, Equatable {
  public let paymentMethod: PaymentMethodResponseDTO

  public init(paymentMethod: PaymentMethodResponseDTO) {
    self.paymentMethod = paymentMethod
  }
}
