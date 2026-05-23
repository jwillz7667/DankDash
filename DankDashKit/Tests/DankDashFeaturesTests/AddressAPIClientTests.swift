import XCTest
import Foundation
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

final class AddressAPIClientTests: XCTestCase {
  func test_unimplementedClient_everyMethodThrows() async {
    let client = AddressAPIClient.unimplemented
    await assertThrows(try await client.listAddresses(), expectedMatch: "listAddresses")
    await assertThrows(
      try await client.createAddress(stubCreateBody()),
      expectedMatch: "createAddress"
    )
    await assertThrows(
      try await client.patchAddress(UUID(), PatchAddressRequestDTO(isDefault: true)),
      expectedMatch: "patchAddress"
    )
  }

  func test_customClient_passesArgumentsThrough() async throws {
    let probe = Locker<(UUID, PatchAddressRequestDTO)?>(value: nil)
    let stub = makeStubAddress()
    let client = AddressAPIClient(
      listAddresses: { [stub] },
      createAddress: { _ in stub },
      patchAddress: { id, body in
        await probe.set((id, body))
        return stub
      }
    )

    let id = UUID()
    let body = PatchAddressRequestDTO(label: "Home", isDefault: true)
    _ = try await client.patchAddress(id, body)
    let observed = await probe.value
    XCTAssertEqual(observed?.0, id)
    XCTAssertEqual(observed?.1.label, "Home")
    XCTAssertEqual(observed?.1.isDefault, true)
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
    } catch let error as AddressAPIError {
      if case let .unimplemented(name) = error {
        XCTAssertTrue(
          name.contains(expectedMatch),
          "unimplemented(\(name)) did not match \(expectedMatch)",
          file: file, line: line
        )
      } else {
        XCTFail("unexpected AddressAPIError: \(error)", file: file, line: line)
      }
    } catch {
      XCTFail("unexpected error type: \(error)", file: file, line: line)
    }
  }

  private func stubCreateBody() -> CreateAddressRequestDTO {
    CreateAddressRequestDTO(
      label: "Home",
      line1: "123 Main St",
      city: "Minneapolis",
      region: "MN",
      postalCode: "55401",
      latitude: 44.98,
      longitude: -93.27,
      setAsDefault: true
    )
  }

  private func makeStubAddress() -> UserAddress {
    UserAddress(
      id: UUID(),
      label: "Home",
      line1: "123 Main St",
      line2: nil,
      city: "Minneapolis",
      region: "MN",
      postalCode: "55401",
      country: "US",
      location: Coordinate(latitude: 44.98, longitude: -93.27),
      isDefault: true,
      isValidated: true,
      validatedAt: Date(timeIntervalSinceReferenceDate: 0),
      deliveryInstructions: nil,
      createdAt: Date(timeIntervalSinceReferenceDate: 0),
      updatedAt: Date(timeIntervalSinceReferenceDate: 0)
    )
  }
}

private actor Locker<T: Sendable> {
  private(set) var value: T
  init(value: T) { self.value = value }
  func set(_ newValue: T) { self.value = newValue }
}
