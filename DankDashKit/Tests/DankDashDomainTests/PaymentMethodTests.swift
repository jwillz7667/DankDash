import XCTest
@testable import DankDashDomain

final class PaymentMethodTests: XCTestCase {
  func test_displayName_bankWithNameAndTail() {
    XCTAssertEqual(make(bankName: "Chase", last4: "1234").displayName, "Chase ••1234")
  }

  func test_displayName_bankNameOnly() {
    XCTAssertEqual(make(bankName: "Chase", last4: nil).displayName, "Chase")
  }

  func test_displayName_tailOnly() {
    XCTAssertEqual(make(bankName: nil, last4: "1234").displayName, "Bank account ••1234")
  }

  func test_displayName_noMetadata_fallsBackToTypeLabel() {
    XCTAssertEqual(make(bankName: nil, last4: nil).displayName, "Bank account")
  }

  func test_displayName_blankBankNameTreatedAsMissing() {
    XCTAssertEqual(make(bankName: "   ", last4: "1234").displayName, "Bank account ••1234")
  }

  func test_displayName_cash() {
    XCTAssertEqual(make(type: .cash, bankName: nil, last4: nil).displayName, "Cash on delivery")
  }

  func test_isUsable_onlyActive() {
    XCTAssertTrue(make(status: .active).isUsable)
    XCTAssertFalse(make(status: .pending).isUsable)
    XCTAssertFalse(make(status: .failed).isUsable)
    XCTAssertFalse(make(status: .revoked).isUsable)
  }

  func test_typeAndStatus_rawValuesMatchWire() {
    XCTAssertEqual(PaymentMethodType.aeropayACH.rawValue, "aeropay_ach")
    XCTAssertEqual(PaymentMethodType.cash.rawValue, "cash")
    XCTAssertEqual(PaymentMethodStatus.active.rawValue, "active")
    XCTAssertEqual(PaymentMethodStatus.revoked.rawValue, "revoked")
  }

  private func make(
    type: PaymentMethodType = .aeropayACH,
    bankName: String? = "Test Bank",
    last4: String? = "1234",
    status: PaymentMethodStatus = .active
  ) -> PaymentMethod {
    PaymentMethod(
      id: UUID(),
      type: type,
      aeropayPaymentMethodRef: type == .cash ? nil : "ba_test_123",
      bankName: bankName,
      last4: last4,
      isDefault: false,
      status: status,
      createdAt: Date(timeIntervalSinceReferenceDate: 0),
      updatedAt: Date(timeIntervalSinceReferenceDate: 0)
    )
  }
}
