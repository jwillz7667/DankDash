import XCTest
import ComposableArchitecture
import DankDashNetwork
@testable import DankDashFeatures

@MainActor
final class ProfileEditFeatureTests: XCTestCase {
  private func makeUser(firstName: String?, lastName: String?) -> UserSummaryDTO {
    UserSummaryDTO(
      id: "0190b7a4-9c00-72f5-a6b0-1c6f77ce9001",
      email: "alice.kim@example.com",
      phone: nil,
      firstName: firstName,
      lastName: lastName,
      role: "customer",
      status: "active",
      kycVerified: true,
      mfaEnabled: false,
      createdAt: "2026-01-01T00:00:00.000Z"
    )
  }

  func test_saveTapped_success_emitsSavedDelegate_withRefreshedUser() async {
    let updated = makeUser(firstName: "Alicia", lastName: "Kim")
    let store = TestStore(
      initialState: ProfileEditFeature.State(
        firstName: "Alicia",
        lastName: "Kim",
        email: "alice.kim@example.com"
      )
    ) {
      ProfileEditFeature()
    } withDependencies: {
      $0.meAPIClient.updateProfile = { request in
        // Names are trimmed before the request is built so the preview
        // matches the server's `.trim()` constraint.
        XCTAssertEqual(request.firstName, "Alicia")
        XCTAssertEqual(request.lastName, "Kim")
        return updated
      }
    }

    await store.send(.saveTapped) { $0.isSubmitting = true }
    await store.receive(\.saveResponse.success) { $0.isSubmitting = false }
    await store.receive(\.delegate.saved)
  }

  func test_saveTapped_trimsWhitespaceBeforeSending() async {
    let saved = makeUser(firstName: "Alice", lastName: "Kim")
    let store = TestStore(
      initialState: ProfileEditFeature.State(
        firstName: "  Alice  ",
        lastName: "  Kim ",
        email: "alice.kim@example.com"
      )
    ) {
      ProfileEditFeature()
    } withDependencies: {
      $0.meAPIClient.updateProfile = { request in
        XCTAssertEqual(request.firstName, "Alice")
        XCTAssertEqual(request.lastName, "Kim")
        return saved
      }
    }

    await store.send(.saveTapped) { $0.isSubmitting = true }
    await store.receive(\.saveResponse.success) { $0.isSubmitting = false }
    await store.receive(\.delegate.saved)
  }

  func test_saveTapped_emptyName_isIgnored() async {
    // No stub: if the guard let the effect run, `.unimplemented` would throw.
    let store = TestStore(
      initialState: ProfileEditFeature.State(firstName: "", lastName: "Kim")
    ) {
      ProfileEditFeature()
    }

    await store.send(.saveTapped)  // canSave is false — no state change, no effect
  }

  func test_saveTapped_serverError_surfacesServerMessage() async {
    let envelope = ErrorEnvelope(
      error: .init(code: "NAME_INVALID", message: "That name isn't allowed.")
    )
    let store = TestStore(
      initialState: ProfileEditFeature.State(
        firstName: "Alice",
        lastName: "Kim",
        email: "alice.kim@example.com"
      )
    ) {
      ProfileEditFeature()
    } withDependencies: {
      $0.meAPIClient.updateProfile = { _ in
        throw APIError.server(status: 422, envelope: envelope)
      }
    }

    await store.send(.saveTapped) { $0.isSubmitting = true }
    await store.receive(\.saveResponse.failure) {
      $0.isSubmitting = false
      $0.error = "That name isn't allowed."
    }
  }

  func test_fieldChange_clearsPriorError() async {
    let store = TestStore(
      initialState: ProfileEditFeature.State(
        firstName: "Alice",
        lastName: "Kim",
        error: "stale error"
      )
    ) {
      ProfileEditFeature()
    }

    await store.send(.firstNameChanged("Alicia")) {
      $0.firstName = "Alicia"
      $0.error = nil
    }
  }

  func test_cancelTapped_emitsCancelledDelegate() async {
    let store = TestStore(initialState: ProfileEditFeature.State()) {
      ProfileEditFeature()
    }

    await store.send(.cancelTapped)
    await store.receive(\.delegate.cancelled)
  }
}
