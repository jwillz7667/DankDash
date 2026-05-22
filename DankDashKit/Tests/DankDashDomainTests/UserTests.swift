import XCTest
@testable import DankDashDomain

final class UserTests: XCTestCase {
  private func makeUser(
    firstName: String? = "Jane",
    lastName: String? = "Doe",
    role: UserRole = .customer,
    status: UserStatus = .active
  ) -> User {
    User(
      id: UUID(uuidString: "11111111-2222-3333-4444-555555555555")!,
      email: Email("jane@dankdash.test")!,
      phone: Phone("+14155551234"),
      firstName: firstName,
      lastName: lastName,
      role: role,
      status: status,
      kycVerified: true,
      mfaEnabled: false,
      createdAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
  }

  func test_displayNameUsesFirstAndLast() {
    XCTAssertEqual(makeUser().displayName, "Jane Doe")
  }

  func test_displayNameFallsBackToEmailWhenNamesMissing() {
    XCTAssertEqual(
      makeUser(firstName: nil, lastName: nil).displayName,
      "jane@dankdash.test"
    )
  }

  func test_displayNameSkipsEmptyComponent() {
    XCTAssertEqual(makeUser(firstName: "Jane", lastName: "").displayName, "Jane")
    XCTAssertEqual(makeUser(firstName: "", lastName: "Doe").displayName, "Doe")
  }

  func test_userRoleEnumCoversBackendValues() {
    // Mirrors apps/api/.../user-summary.dto.ts UserRoleSchema enum.
    XCTAssertEqual(UserRole.allCases.count, 7)
    XCTAssertEqual(
      Set(UserRole.allCases.map(\.rawValue)),
      Set(["customer", "budtender", "manager", "owner", "driver", "admin", "superadmin"])
    )
  }

  func test_userStatusMapsPendingKycToSnakeCase() {
    XCTAssertEqual(UserStatus.pendingKyc.rawValue, "pending_kyc")
  }

  func test_isHashable() {
    let a = makeUser()
    let b = makeUser()
    XCTAssertEqual(a, b)
    XCTAssertEqual(Set([a, b]).count, 1)
  }
}
