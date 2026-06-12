import XCTest
@testable import DankDashStorage

final class BiometryEnrollmentMonitorTests: XCTestCase {
  private var suiteName: String!
  private var defaults: UserDefaults!

  override func setUp() {
    super.setUp()
    suiteName = "test.dankdash.enrollment.\(UUID().uuidString)"
    defaults = UserDefaults(suiteName: suiteName)
  }

  override func tearDown() {
    defaults.removePersistentDomain(forName: suiteName)
    defaults = nil
    suiteName = nil
    super.tearDown()
  }

  private func monitor(hash: Data?) -> BiometryEnrollmentMonitor {
    BiometryEnrollmentMonitor(defaults: defaults, currentHash: { hash })
  }

  func test_firstCheckAdoptsBaseline_thenDetectsChange() {
    // Installs predating the monitor have no baseline — the first check
    // must adopt, not sign the user out.
    XCTAssertFalse(monitor(hash: Data("face-set-a".utf8)).hasEnrollmentChanged())

    XCTAssertTrue(monitor(hash: Data("face-set-b".utf8)).hasEnrollmentChanged())
  }

  func test_sameHash_reportsUnchanged() {
    let m = monitor(hash: Data("face-set-a".utf8))
    m.recordBaseline()

    XCTAssertFalse(m.hasEnrollmentChanged())
  }

  func test_unreadableHash_neverReportsChange() {
    // nil means "unknown" (device locked in a driver's pocket, biometry
    // unavailable) — treating it as "changed" would sign out an
    // actively-driving driver mid-shift.
    monitor(hash: Data("face-set-a".utf8)).recordBaseline()

    XCTAssertFalse(monitor(hash: nil).hasEnrollmentChanged())
  }

  func test_recordBaseline_withUnreadableHash_isNoOp() {
    monitor(hash: Data("face-set-a".utf8)).recordBaseline()
    monitor(hash: nil).recordBaseline()

    XCTAssertFalse(
      monitor(hash: Data("face-set-a".utf8)).hasEnrollmentChanged(),
      "a nil snapshot must not clobber a valid baseline"
    )
  }

  func test_clearBaseline_makesNextCheckAdopt() {
    let a = monitor(hash: Data("face-set-a".utf8))
    a.recordBaseline()
    a.clearBaseline()

    XCTAssertFalse(
      monitor(hash: Data("face-set-b".utf8)).hasEnrollmentChanged(),
      "after sign-out the next session adopts the current enrollment"
    )
  }

  func test_recordBaseline_rebaselines_afterChange() {
    // A fresh login re-baselines: the new session is trusted under
    // today's biometric set even if it changed while signed out.
    monitor(hash: Data("face-set-a".utf8)).recordBaseline()
    let b = monitor(hash: Data("face-set-b".utf8))
    b.recordBaseline()

    XCTAssertFalse(b.hasEnrollmentChanged())
  }
}
