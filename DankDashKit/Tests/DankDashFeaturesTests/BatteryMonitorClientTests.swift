import XCTest
@testable import DankDashFeatures

/// Tests cover the fixtures + the `shouldThrottleForBattery` rule, the
/// behavior the shift reducer hangs off of. The live coordinator wraps
/// `UIDevice` and is exercised manually in the simulator (per the Phase
/// 19 manual-smoke checklist).
final class BatteryMonitorClientTests: XCTestCase {
  // MARK: - Unimplemented fixture

  func test_unimplementedClient_snapshotIsUnknownAndNotThrottled() {
    let client = BatteryMonitorClient.unimplemented
    let snapshot = client.snapshot()
    XCTAssertNil(snapshot.level)
    XCTAssertEqual(snapshot.state, .unknown)
    XCTAssertFalse(snapshot.isLowPowerModeEnabled)
    XCTAssertFalse(
      snapshot.shouldThrottleForBattery,
      "unknown level + no low-power mode should not throttle"
    )
  }

  func test_unimplementedClient_eventStreamFinishesImmediately() async {
    let client = BatteryMonitorClient.unimplemented
    var seen: [BatterySnapshot] = []
    for await snap in client.events() {
      seen.append(snap)
    }
    XCTAssertEqual(seen.count, 0)
  }

  // MARK: - Test fixture

  func test_testClient_replaysEventsInOrder() async {
    let initial = BatterySnapshot(level: 0.95, state: .unplugged, isLowPowerModeEnabled: false)
    let events = [
      BatterySnapshot(level: 0.50, state: .unplugged, isLowPowerModeEnabled: false),
      BatterySnapshot(level: 0.18, state: .unplugged, isLowPowerModeEnabled: false),
    ]
    let client = BatteryMonitorClient.test(initial: initial, events: events)
    XCTAssertEqual(client.snapshot(), initial)

    var seen: [BatterySnapshot] = []
    for await snap in client.events() {
      seen.append(snap)
    }
    XCTAssertEqual(seen, events)
    XCTAssertEqual(client.snapshot(), events.last, "snapshot tracks the most recent event")
  }

  // MARK: - shouldThrottleForBattery

  func test_shouldThrottle_isTrueWhenLowPowerModeEnabled() {
    let snap = BatterySnapshot(level: 0.95, state: .unplugged, isLowPowerModeEnabled: true)
    XCTAssertTrue(snap.shouldThrottleForBattery)
  }

  func test_shouldThrottle_isTrueAtOrBelow20PercentOnBattery() {
    let snap = BatterySnapshot(level: 0.20, state: .unplugged, isLowPowerModeEnabled: false)
    XCTAssertTrue(snap.shouldThrottleForBattery, "20% exact boundary throttles")

    let lower = BatterySnapshot(level: 0.15, state: .unplugged, isLowPowerModeEnabled: false)
    XCTAssertTrue(lower.shouldThrottleForBattery)
  }

  func test_shouldThrottle_isFalseAbove20PercentOnBattery() {
    let snap = BatterySnapshot(level: 0.21, state: .unplugged, isLowPowerModeEnabled: false)
    XCTAssertFalse(snap.shouldThrottleForBattery)
  }

  func test_shouldThrottle_isFalseWhenChargingRegardlessOfLevel() {
    let snap = BatterySnapshot(level: 0.05, state: .charging, isLowPowerModeEnabled: false)
    XCTAssertFalse(snap.shouldThrottleForBattery, "charging trumps the 20% floor")
  }

  func test_shouldThrottle_isFalseWhenFullRegardlessOfLevel() {
    let snap = BatterySnapshot(level: 1.0, state: .full, isLowPowerModeEnabled: false)
    XCTAssertFalse(snap.shouldThrottleForBattery)
  }

  func test_shouldThrottle_isFalseForUnknownLevel() {
    let snap = BatterySnapshot(level: nil, state: .unknown, isLowPowerModeEnabled: false)
    XCTAssertFalse(snap.shouldThrottleForBattery, "unknown level shouldn't accidentally throttle")
  }
}
