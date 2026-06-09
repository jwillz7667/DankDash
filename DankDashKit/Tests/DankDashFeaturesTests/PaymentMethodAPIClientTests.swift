import XCTest
import Foundation
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

final class PaymentMethodAPIClientTests: XCTestCase {
  func test_unimplementedClient_everyMethodThrows() async {
    let client = PaymentMethodAPIClient.unimplemented
    await assertThrows(try await client.listPaymentMethods(), expectedMatch: "listPaymentMethods")
    await assertThrows(try await client.linkAeropay(), expectedMatch: "linkAeropay")
    await assertThrows(try await client.setDefault(UUID()), expectedMatch: "setDefault")
    await assertThrows(
      try await client.deletePaymentMethod(UUID()),
      expectedMatch: "deletePaymentMethod"
    )
  }

  func test_setDefault_passesIdThrough() async throws {
    let probe = Locker<UUID?>(value: nil)
    let stub = makeStubMethod()
    let client = PaymentMethodAPIClient(
      listPaymentMethods: { [stub] },
      linkAeropay: { makeStubSession() },
      setDefault: { id in
        await probe.set(id)
        return stub
      },
      deletePaymentMethod: { _ in }
    )

    let id = UUID()
    _ = try await client.setDefault(id)
    let observed = await probe.value
    XCTAssertEqual(observed, id)
  }

  func test_deletePaymentMethod_passesIdThrough() async throws {
    let probe = Locker<UUID?>(value: nil)
    let stub = makeStubMethod()
    let client = PaymentMethodAPIClient(
      listPaymentMethods: { [stub] },
      linkAeropay: { makeStubSession() },
      setDefault: { _ in stub },
      deletePaymentMethod: { id in await probe.set(id) }
    )

    let id = UUID()
    try await client.deletePaymentMethod(id)
    let observed = await probe.value
    XCTAssertEqual(observed, id)
  }

  func test_linkAeropay_returnsSession() async throws {
    let session = makeStubSession()
    let client = PaymentMethodAPIClient(
      listPaymentMethods: { [] },
      linkAeropay: { session },
      setDefault: { _ in makeStubMethod() },
      deletePaymentMethod: { _ in }
    )

    let observed = try await client.linkAeropay()
    XCTAssertEqual(observed, session)
  }

  // MARK: - Helpers

  private func assertThrows<T>(
    _ expression: @autoclosure () async throws -> T,
    expectedMatch: String,
    file: StaticString = #file,
    line: UInt = #line
  ) async {
    do {
      _ = try await expression()
      XCTFail("expected to throw containing \(expectedMatch)", file: file, line: line)
    } catch let error as PaymentMethodAPIError {
      if case let .unimplemented(name) = error {
        XCTAssertTrue(
          name.contains(expectedMatch),
          "unimplemented(\(name)) did not match \(expectedMatch)",
          file: file, line: line
        )
      } else {
        XCTFail("unexpected PaymentMethodAPIError: \(error)", file: file, line: line)
      }
    } catch {
      XCTFail("unexpected error type: \(error)", file: file, line: line)
    }
  }
}

private func makeStubMethod() -> PaymentMethod {
  PaymentMethod(
    id: UUID(),
    type: .aeropayACH,
    aeropayPaymentMethodRef: "ba_test_123",
    bankName: "Test Bank",
    last4: "1234",
    isDefault: true,
    status: .active,
    createdAt: Date(timeIntervalSinceReferenceDate: 0),
    updatedAt: Date(timeIntervalSinceReferenceDate: 0)
  )
}

private func makeStubSession() -> AeropayLinkSession {
  AeropayLinkSession(
    id: "link_session_test_1",
    hostedUrl: URL(string: "https://link.aeropay.com/session/test_1")!,
    expiresAt: Date(timeIntervalSinceReferenceDate: 0)
  )
}

private actor Locker<T: Sendable> {
  private(set) var value: T
  init(value: T) { self.value = value }
  func set(_ newValue: T) { self.value = newValue }
}
