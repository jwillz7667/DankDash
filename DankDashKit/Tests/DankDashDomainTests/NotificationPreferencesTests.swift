import XCTest
@testable import DankDashDomain

final class NotificationPreferencesTests: XCTestCase {
  // MARK: - Defaults

  func test_allOn_everyToggleTrue_noTimestamp() {
    let prefs = NotificationPreferences.allOn
    for toggle in NotificationToggle.allCases {
      XCTAssertTrue(prefs.value(for: toggle), "\(toggle) should default on")
    }
    XCTAssertNil(prefs.updatedAt, "an unsaved preference has no timestamp")
  }

  func test_init_defaultsAllOn() {
    XCTAssertEqual(NotificationPreferences(), NotificationPreferences.allOn)
  }

  // MARK: - value(for:)

  func test_value_readsEachToggleIndependently() {
    let prefs = NotificationPreferences(
      orderUpdatesEnabled: true,
      promotionsEnabled: false,
      pushEnabled: true,
      smsEnabled: false,
      emailEnabled: true
    )
    XCTAssertTrue(prefs.value(for: .orderUpdates))
    XCTAssertFalse(prefs.value(for: .promotions))
    XCTAssertTrue(prefs.value(for: .push))
    XCTAssertFalse(prefs.value(for: .sms))
    XCTAssertTrue(prefs.value(for: .email))
  }

  // MARK: - setting(_:to:)

  func test_setting_flipsOnlyTargetToggle() {
    let updated = NotificationPreferences.allOn.setting(.sms, to: false)
    XCTAssertFalse(updated.value(for: .sms))
    XCTAssertTrue(updated.value(for: .orderUpdates))
    XCTAssertTrue(updated.value(for: .promotions))
    XCTAssertTrue(updated.value(for: .push))
    XCTAssertTrue(updated.value(for: .email))
  }

  func test_setting_isPureNonMutating() {
    let original = NotificationPreferences.allOn
    _ = original.setting(.push, to: false)
    XCTAssertTrue(original.value(for: .push), "setting must not mutate the receiver")
  }

  func test_setting_eachToggleRoundTrips() {
    for toggle in NotificationToggle.allCases {
      let off = NotificationPreferences.allOn.setting(toggle, to: false)
      XCTAssertFalse(off.value(for: toggle))
      let backOn = off.setting(toggle, to: true)
      XCTAssertEqual(backOn, NotificationPreferences.allOn)
    }
  }

  // MARK: - NotificationToggle wire raw values

  func test_toggleRawValues_matchWireKeys() {
    XCTAssertEqual(NotificationToggle.orderUpdates.rawValue, "orderUpdates")
    XCTAssertEqual(NotificationToggle.promotions.rawValue, "promotions")
    XCTAssertEqual(NotificationToggle.push.rawValue, "push")
    XCTAssertEqual(NotificationToggle.sms.rawValue, "sms")
    XCTAssertEqual(NotificationToggle.email.rawValue, "email")
    XCTAssertEqual(NotificationToggle.allCases.count, 5)
  }

  // MARK: - NotificationPreferencesUpdate

  func test_single_carriesExactlyOneToggle() {
    let update = NotificationPreferencesUpdate.single(.promotions, to: false)
    XCTAssertEqual(update.promotionsEnabled, false)
    XCTAssertNil(update.orderUpdatesEnabled)
    XCTAssertNil(update.pushEnabled)
    XCTAssertNil(update.smsEnabled)
    XCTAssertNil(update.emailEnabled)
    XCTAssertFalse(update.isEmpty)
  }

  func test_single_mapsEachToggleToItsField() {
    XCTAssertEqual(NotificationPreferencesUpdate.single(.orderUpdates, to: false).orderUpdatesEnabled, false)
    XCTAssertEqual(NotificationPreferencesUpdate.single(.promotions, to: true).promotionsEnabled, true)
    XCTAssertEqual(NotificationPreferencesUpdate.single(.push, to: false).pushEnabled, false)
    XCTAssertEqual(NotificationPreferencesUpdate.single(.sms, to: true).smsEnabled, true)
    XCTAssertEqual(NotificationPreferencesUpdate.single(.email, to: false).emailEnabled, false)
  }

  func test_isEmpty_trueWhenNoFieldSet() {
    XCTAssertTrue(NotificationPreferencesUpdate().isEmpty)
  }

  func test_isEmpty_falseWhenAnyFieldSet() {
    XCTAssertFalse(NotificationPreferencesUpdate(emailEnabled: true).isEmpty)
  }
}
