import XCTest
import ComposableArchitecture
import DankDashDomain
@testable import DankDashFeatures

@MainActor
final class AgeGateFeatureTests: XCTestCase {
  func test_submit_under21_setsError_doesNotTransition() async {
    let store = TestStore(initialState: AgeGateFeature.State()) {
      AgeGateFeature()
    } withDependencies: {
      $0.date.now = Self.dateFromYMD(year: 2026, month: 5, day: 1)
    }

    await store.send(.monthChanged(6)) { $0.month = 6 }
    await store.send(.dayChanged(15)) { $0.day = 15 }
    await store.send(.yearChanged(2010)) { $0.year = 2010 }
    await store.send(.acknowledgementToggled(true)) { $0.acknowledged = true }

    await store.send(.submitTapped) {
      $0.error = "You must be 21 or older to use DankDash."
    }
  }

  func test_submit_exactly21_passes() async {
    // Reference date is 2026-05-20; a DOB of 2005-05-20 is exactly 21 today.
    let store = TestStore(initialState: AgeGateFeature.State()) {
      AgeGateFeature()
    } withDependencies: {
      $0.date.now = Self.dateFromYMD(year: 2026, month: 5, day: 20)
    }

    await store.send(.monthChanged(5)) { $0.month = 5 }
    await store.send(.dayChanged(20)) { $0.day = 20 }
    await store.send(.yearChanged(2005)) { $0.year = 2005 }
    await store.send(.acknowledgementToggled(true)) { $0.acknowledged = true }

    await store.send(.submitTapped)
    await store.receive(\.delegate.passed)
  }

  func test_submit_invalidDate_setsError() async {
    let store = TestStore(initialState: AgeGateFeature.State()) {
      AgeGateFeature()
    } withDependencies: {
      $0.date.now = Self.dateFromYMD(year: 2026, month: 5, day: 20)
    }

    await store.send(.monthChanged(2)) { $0.month = 2 }
    await store.send(.dayChanged(30)) { $0.day = 30 }  // Feb 30 is invalid
    await store.send(.yearChanged(2000)) { $0.year = 2000 }
    await store.send(.acknowledgementToggled(true)) { $0.acknowledged = true }

    await store.send(.submitTapped) {
      $0.error = "Enter a valid date of birth."
    }
  }

  func test_canSubmit_requiresAcknowledgement() {
    var state = AgeGateFeature.State(month: 5, day: 1, year: 2000)
    XCTAssertFalse(state.canSubmit, "Cannot submit without acknowledgement.")
    state.acknowledged = true
    XCTAssertTrue(state.canSubmit, "Acknowledged + valid DOB allows submit.")
  }

  private static func dateFromYMD(year: Int, month: Int, day: Int) -> Date {
    var components = DateComponents()
    components.year = year
    components.month = month
    components.day = day
    components.hour = 12
    components.timeZone = TimeZone(identifier: "America/Chicago")
    return Calendar(identifier: .gregorian).date(from: components)!
  }
}
