import Foundation

/// Funding source the consumer can use at checkout. Cannabis can't touch
/// the card networks, so the only user-linkable type is an ACH bank
/// account via Aeropay. `cash` (cash on delivery) exists as a server-side
/// enum value but is not creatable from the consumer app — it's modeled
/// here so the list view renders gracefully if the server ever returns one.
public enum PaymentMethodType: String, Sendable, Codable, Hashable, CaseIterable {
  case aeropayACH = "aeropay_ach"
  case cash
}

/// Lifecycle of a payment method. A freshly started Aeropay link lands in
/// `pending`; the `bank_account.linked` webhook promotes it to `active`.
/// `failed` is a link that errored upstream (surfaced with a retry CTA);
/// `revoked` is a method the user or bank has since unlinked.
public enum PaymentMethodStatus: String, Sendable, Codable, Hashable, CaseIterable {
  case pending
  case active
  case failed
  case revoked
}

/// One saved payment method on the caller's account. Mirror of
/// `PaymentMethodResponse` (`GET /v1/payment-methods`).
///
/// `aeropayPaymentMethodRef` is the opaque upstream Aeropay identifier; it
/// is `nil` for `cash`. The client never interprets it — checkout
/// references it server-side. Bank metadata (`bankName` / `last4`) is also
/// `nil` until Aeropay confirms the link and the webhook fills it in, so a
/// `pending` row renders with the generic funding-type label.
public struct PaymentMethod: Identifiable, Hashable, Sendable, Codable {
  public let id: UUID
  public let type: PaymentMethodType
  public let aeropayPaymentMethodRef: String?
  public let bankName: String?
  public let last4: String?
  public let isDefault: Bool
  public let status: PaymentMethodStatus
  public let createdAt: Date
  public let updatedAt: Date

  public init(
    id: UUID,
    type: PaymentMethodType,
    aeropayPaymentMethodRef: String?,
    bankName: String?,
    last4: String?,
    isDefault: Bool,
    status: PaymentMethodStatus,
    createdAt: Date,
    updatedAt: Date
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

  /// Row title. For a bank account it composes the bank name with a
  /// masked tail (`Chase ••1234`), degrading gracefully when either piece
  /// is missing (a `pending` row has neither yet). Cash has no metadata.
  public var displayName: String {
    switch type {
    case .cash:
      return "Cash on delivery"
    case .aeropayACH:
      let trimmedBank = bankName?.trimmingCharacters(in: .whitespacesAndNewlines)
      let bank = (trimmedBank?.isEmpty == false) ? trimmedBank : nil
      let tail = last4.map { "••\($0)" }
      switch (bank, tail) {
      case let (bank?, tail?):
        return "\(bank) \(tail)"
      case let (bank?, nil):
        return bank
      case let (nil, tail?):
        return "Bank account \(tail)"
      case (nil, nil):
        return "Bank account"
      }
    }
  }

  /// Only an `active` method can be promoted to default or charged. The
  /// list view uses this to gate the "Make default" affordance, mirroring
  /// the server's 409 on a non-active promote.
  public var isUsable: Bool { status == .active }
}
