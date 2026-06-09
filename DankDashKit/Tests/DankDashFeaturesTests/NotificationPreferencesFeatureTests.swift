import XCTest
import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

@MainActor
final class NotificationPreferencesFeatureTests: XCTestCase {
  // MARK: - Load

  func test_onAppear_loadsPreferences() async {
    let row = NotificationPreferences(promotionsEnabled: false, smsEnabled: false)
    let store = TestStore(initialState: NotificationPreferencesFeature.State()) {
      NotificationPreferencesFeature()
    } withDependencies: {
      $0.notificationPreferencesAPIClient.getPreferences = { row }
    }

    await store.send(.onAppear) { $0.isLoading = true }
    await store.receive(\.preferencesLoaded.success) {
      $0.isLoading = false
      $0.preferences = row
    }
  }

  func test_onAppear_whenAlreadyLoaded_isNoop() async {
    let store = TestStore(
      initialState: NotificationPreferencesFeature.State(preferences: .allOn)
    ) {
      NotificationPreferencesFeature()
    }
    await store.send(.onAppear)
  }

  func test_onAppear_failure_surfacesError() async {
    let store = TestStore(initialState: NotificationPreferencesFeature.State()) {
      NotificationPreferencesFeature()
    } withDependencies: {
      $0.notificationPreferencesAPIClient.getPreferences = {
        throw NotificationPreferencesAPIError.unimplemented("getPreferences")
      }
    }

    await store.send(.onAppear) { $0.isLoading = true }
    await store.receive(\.preferencesLoaded.failure) {
      $0.isLoading = false
      $0.error = String(describing: NotificationPreferencesAPIError.unimplemented("getPreferences"))
    }
  }

  func test_refreshTapped_clearsErrorAndReloads() async {
    let store = TestStore(
      initialState: NotificationPreferencesFeature.State(preferences: .allOn, error: "stale")
    ) {
      NotificationPreferencesFeature()
    } withDependencies: {
      $0.notificationPreferencesAPIClient.getPreferences = { .allOn }
    }

    await store.send(.refreshTapped) { $0.error = nil }
    await store.receive(\.preferencesLoaded.success)
  }

  // MARK: - Toggle (optimistic)

  func test_toggleChanged_optimisticFlip_thenAdoptsServerRow() async {
    // The PATCH echoes the authoritative full row, which the feature adopts
    // wholesale (note the fresh updatedAt the client invented isn't local).
    let serverRow = NotificationPreferences(promotionsEnabled: false, updatedAt: Date(timeIntervalSince1970: 100))
    let probe = Locker<NotificationPreferencesUpdate?>(value: nil)
    let store = TestStore(
      initialState: NotificationPreferencesFeature.State(preferences: .allOn)
    ) {
      NotificationPreferencesFeature()
    } withDependencies: {
      $0.notificationPreferencesAPIClient.updatePreferences = { update in
        await probe.set(update)
        return serverRow
      }
    }

    await store.send(.toggleChanged(.promotions, false)) {
      $0.preferences = NotificationPreferences.allOn.setting(.promotions, to: false)
      $0.savingToggles = [.promotions]
    }
    await store.receive(\.toggleResponse) {
      $0.savingToggles = []
      $0.preferences = serverRow
    }

    let sent = await probe.value
    XCTAssertEqual(sent, .single(.promotions, to: false))
  }

  func test_toggleChanged_failure_revertsToPreviousAndSurfacesError() async {
    let store = TestStore(
      initialState: NotificationPreferencesFeature.State(preferences: .allOn)
    ) {
      NotificationPreferencesFeature()
    } withDependencies: {
      $0.notificationPreferencesAPIClient.updatePreferences = { _ in
        throw NotificationPreferencesAPIError.unimplemented("updatePreferences")
      }
    }

    await store.send(.toggleChanged(.sms, false)) {
      $0.preferences = NotificationPreferences.allOn.setting(.sms, to: false)
      $0.savingToggles = [.sms]
    }
    await store.receive(\.toggleResponse) {
      $0.savingToggles = []
      $0.preferences = .allOn  // reverted
      $0.error = String(describing: NotificationPreferencesAPIError.unimplemented("updatePreferences"))
    }
  }

  func test_toggleChanged_beforeLoad_isNoop() async {
    let store = TestStore(initialState: NotificationPreferencesFeature.State()) {
      NotificationPreferencesFeature()
    }
    await store.send(.toggleChanged(.push, false))
  }

  func test_toggleChanged_whileTogglesSaving_isNoop() async {
    let store = TestStore(
      initialState: NotificationPreferencesFeature.State(
        preferences: .allOn,
        savingToggles: [.push]
      )
    ) {
      NotificationPreferencesFeature()
    }
    await store.send(.toggleChanged(.push, false))
  }

  func test_toggleChanged_toSameValue_isNoop() async {
    let store = TestStore(
      initialState: NotificationPreferencesFeature.State(preferences: .allOn)
    ) {
      NotificationPreferencesFeature()
    }
    // push is already true in allOn — flipping it to true is a no-op.
    await store.send(.toggleChanged(.push, true))
  }

  func test_toggleChanged_revertLeavesOtherInFlightTogglesUntouched() async {
    // Two toggles in flight; the failing one reverts only itself.
    let store = TestStore(
      initialState: NotificationPreferencesFeature.State(
        preferences: NotificationPreferences.allOn.setting(.email, to: false),
        savingToggles: [.email]
      )
    ) {
      NotificationPreferencesFeature()
    } withDependencies: {
      $0.notificationPreferencesAPIClient.updatePreferences = { _ in
        throw NotificationPreferencesAPIError.unimplemented("updatePreferences")
      }
    }

    await store.send(.toggleChanged(.sms, false)) {
      $0.preferences = NotificationPreferences.allOn
        .setting(.email, to: false)
        .setting(.sms, to: false)
      $0.savingToggles = [.email, .sms]
    }
    await store.receive(\.toggleResponse) {
      // Only sms reverts; email (still in flight, optimistically off) stays off.
      $0.savingToggles = [.email]
      $0.preferences = NotificationPreferences.allOn.setting(.email, to: false)
      $0.error = String(describing: NotificationPreferencesAPIError.unimplemented("updatePreferences"))
    }
  }
}

private actor Locker<T: Sendable> {
  private(set) var value: T
  init(value: T) { self.value = value }
  func set(_ newValue: T) { self.value = newValue }
}
