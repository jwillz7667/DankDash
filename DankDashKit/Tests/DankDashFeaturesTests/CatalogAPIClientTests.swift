import XCTest
import Foundation
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

final class CatalogAPIClientTests: XCTestCase {
  func test_unimplementedClient_everyMethodThrows() async {
    let client = CatalogAPIClient.unimplemented
    await assertThrows(
      try await client.listDispensaries(nil),
      expectedMatch: "listDispensaries"
    )
    await assertThrows(
      try await client.getDispensary(UUID()),
      expectedMatch: "getDispensary"
    )
    await assertThrows(
      try await client.getMenu(UUID()),
      expectedMatch: "getMenu"
    )
    await assertThrows(
      try await client.getProduct(UUID()),
      expectedMatch: "getProduct"
    )
    await assertThrows(
      try await client.listCategories(),
      expectedMatch: "listCategories"
    )
    await assertThrows(
      try await client.searchProducts(SearchProductsQuery()),
      expectedMatch: "searchProducts"
    )
  }

  func test_customClient_passesArgumentsThrough() async throws {
    let probe = Locker<UUID?>(value: nil)
    let client = CatalogAPIClient(
      listDispensaries: { _ in [] },
      getDispensary: { id in
        await probe.set(id)
        throw CatalogAPIError.malformedPayload("ignored")
      },
      getMenu: { _ in (UUID(), []) },
      getProduct: { _ in throw CatalogAPIError.malformedPayload("Product") },
      listCategories: { [] },
      searchProducts: { _ in
        SearchProductsResult(results: [], categoryFacets: [], strainTypeFacets: [], page: SearchPage(limit: 24, offset: 0, total: 0))
      }
    )

    let target = UUID()
    do { _ = try await client.getDispensary(target) } catch { /* expected */ }
    let observed = await probe.value
    XCTAssertEqual(observed, target)
  }

  func test_searchProductsResult_isEquatableValueType() {
    let a = SearchProductsResult(
      results: [],
      categoryFacets: [],
      strainTypeFacets: [],
      page: SearchPage(limit: 24, offset: 0, total: 0)
    )
    let b = SearchProductsResult(
      results: [],
      categoryFacets: [],
      strainTypeFacets: [],
      page: SearchPage(limit: 24, offset: 0, total: 0)
    )
    XCTAssertEqual(a, b)
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
    } catch let error as CatalogAPIError {
      if case let .unimplemented(name) = error {
        XCTAssertTrue(name.contains(expectedMatch), "unimplemented(\(name)) did not match \(expectedMatch)", file: file, line: line)
      } else {
        XCTFail("unexpected CatalogAPIError: \(error)", file: file, line: line)
      }
    } catch {
      XCTFail("unexpected error type: \(error)", file: file, line: line)
    }
  }
}

/// Tiny actor used to capture a value from a `@Sendable` closure without
/// sharing mutable state across actor boundaries.
private actor Locker<T: Sendable> {
  private(set) var value: T

  init(value: T) { self.value = value }

  func set(_ newValue: T) { self.value = newValue }
}
