import XCTest
@testable import DankDashNetwork

/// Endpoint-shape pinning for the `/v1/me` surface — path, method, auth
/// flag, and the encoded `PATCH` body. A rename or path drift surfaces
/// here rather than at runtime.
final class MeEndpointsTests: XCTestCase {
  private let encoder = JSONEncoder()

  func test_current_getsMe() {
    let endpoint = MeEndpoints.current()
    XCTAssertEqual(endpoint.method, .GET)
    XCTAssertEqual(endpoint.path, "v1/me")
    XCTAssertTrue(endpoint.requiresAuth)
    XCTAssertNil(endpoint.body)
  }

  func test_updateProfile_patchesMe_withBothNames() throws {
    let endpoint = MeEndpoints.updateProfile(
      body: UpdateMeRequestDTO(firstName: "Alice", lastName: "Kim")
    )
    XCTAssertEqual(endpoint.method, .PATCH)
    XCTAssertEqual(endpoint.path, "v1/me")
    XCTAssertTrue(endpoint.requiresAuth)

    let data = try XCTUnwrap(endpoint.body).encode(using: encoder)
    let payload = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: String])
    XCTAssertEqual(payload["firstName"], "Alice")
    XCTAssertEqual(payload["lastName"], "Kim")
    XCTAssertEqual(payload.count, 2)
  }

  func test_updateProfile_omitsNilFields_keepingPatchPartial() throws {
    // A name-only edit must not emit `lastName: null` — the server schema
    // is `.strict()` and treats the patch as partial; a null would either
    // be rejected or clobber the stored value.
    let data = try encoder.encode(UpdateMeRequestDTO(firstName: "Alice"))
    let payload = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: String])
    XCTAssertEqual(payload["firstName"], "Alice")
    XCTAssertNil(payload["lastName"])
    XCTAssertEqual(payload.count, 1)
  }
}
