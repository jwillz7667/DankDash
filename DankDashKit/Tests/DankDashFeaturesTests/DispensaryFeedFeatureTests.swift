import XCTest
import Foundation
import ComposableArchitecture
import DankDashDomain
@testable import DankDashFeatures

@MainActor
final class DispensaryFeedFeatureTests: XCTestCase {
  // MARK: - .task seeds from cache and reads authorization

  func test_task_emptyCache_notDetermined_doesNothingBeyondReadingStatus() async {
    let store = TestStore(initialState: DispensaryFeedFeature.State()) {
      DispensaryFeedFeature()
    } withDependencies: {
      $0.catalogCacheClient = .unimplemented
      $0.catalogAPIClient = .unimplemented
      $0.locationClient = .test(status: .notDetermined)
      $0.date = .constant(Date(timeIntervalSince1970: 1_780_000_000))
    }

    await store.send(.task)
    await store.receive(\.cacheLoaded)
    await store.receive(\.authorizationStatusResolved)
  }

  func test_task_cachedSnapshot_paintsImmediately() async {
    let cached = [Self.makeDispensary(legalName: "Bloom", ratingAvg: Decimal(string: "4.6"))]
    var cacheClient = CatalogCacheClient.unimplemented
    cacheClient.readFeed = { _ in
      .init(dispensaries: cached, queriedAt: Date(timeIntervalSince1970: 1_780_000_000))
    }

    let store = TestStore(initialState: DispensaryFeedFeature.State()) {
      DispensaryFeedFeature()
    } withDependencies: {
      $0.catalogCacheClient = cacheClient
      $0.catalogAPIClient = .unimplemented
      $0.locationClient = .test(status: .denied)
      $0.date = .constant(Date(timeIntervalSince1970: 1_780_000_000))
    }

    await store.send(.task)
    await store.receive(\.cacheLoaded) {
      $0.dispensaries = cached
      $0.isShowingFromCache = true
    }
    await store.receive(\.authorizationStatusResolved) {
      $0.authorizationStatus = .denied
    }
  }

  // MARK: - authorization branching

  func test_authorizationAuthorized_triggersEnableLocationFlow() async {
    let coord = Coordinate(latitude: 44.97, longitude: -93.26)
    let fetched = [Self.makeDispensary(legalName: "Bloom")]
    var api = CatalogAPIClient.unimplemented
    api.listDispensaries = { passed in
      // Discovery is location-agnostic: the resolved coordinate lands in
      // state (for checkout pre-fill) but is never used to geo-filter the
      // feed, so the fetch always passes nil.
      XCTAssertNil(passed, "Discovery feed must not be geo-filtered by device location.")
      return fetched
    }

    let store = TestStore(initialState: DispensaryFeedFeature.State()) {
      DispensaryFeedFeature()
    } withDependencies: {
      $0.catalogCacheClient = .unimplemented
      $0.catalogAPIClient = api
      $0.locationClient = .test(status: .authorized, coordinate: coord)
      $0.date = .constant(Date(timeIntervalSince1970: 1_780_000_000))
    }

    await store.send(.authorizationStatusResolved(.authorized)) {
      $0.authorizationStatus = .authorized
      $0.isLoading = true
      $0.error = nil
    }
    await store.receive(\.locationResolved) {
      $0.coordinate = coord
    }
    await store.receive(\.fetchRequested) {
      $0.hasAttemptedFetch = true
    }
    await store.receive(\.fetchResponse.success) {
      $0.isLoading = false
      $0.dispensaries = fetched
      $0.isShowingFromCache = false
      $0.error = nil
    }
  }

  func test_enableLocationTapped_grantedThenFetches() async {
    let coord = Coordinate(latitude: 44.97, longitude: -93.26)
    let fetched = [Self.makeDispensary(legalName: "From Network")]
    var api = CatalogAPIClient.unimplemented
    api.listDispensaries = { _ in fetched }

    let store = TestStore(
      initialState: DispensaryFeedFeature.State(authorizationStatus: .notDetermined)
    ) {
      DispensaryFeedFeature()
    } withDependencies: {
      $0.catalogCacheClient = .unimplemented
      $0.catalogAPIClient = api
      $0.locationClient = .test(status: .authorized, coordinate: coord)
      $0.date = .constant(Date(timeIntervalSince1970: 1_780_000_000))
    }

    await store.send(.enableLocationTapped) {
      $0.isLoading = true
      $0.error = nil
    }
    await store.receive(\.authorizationStatusChanged) {
      $0.authorizationStatus = .authorized
    }
    await store.receive(\.locationResolved) {
      $0.coordinate = coord
    }
    await store.receive(\.fetchRequested) {
      $0.hasAttemptedFetch = true
    }
    await store.receive(\.fetchResponse.success) {
      $0.isLoading = false
      $0.dispensaries = fetched
    }
  }

  func test_enableLocationTapped_deniedFallsBackToNoLocationFetch() async {
    let fetched = [Self.makeDispensary(legalName: "No Location")]
    var api = CatalogAPIClient.unimplemented
    api.listDispensaries = { passed in
      XCTAssertNil(passed, "Denied prompt should fall back to nil coordinate.")
      return fetched
    }

    let store = TestStore(initialState: DispensaryFeedFeature.State()) {
      DispensaryFeedFeature()
    } withDependencies: {
      $0.catalogCacheClient = .unimplemented
      $0.catalogAPIClient = api
      $0.locationClient = .test(status: .denied)
      $0.date = .constant(Date(timeIntervalSince1970: 1_780_000_000))
    }

    await store.send(.enableLocationTapped) {
      $0.isLoading = true
      $0.error = nil
    }
    await store.receive(\.authorizationStatusChanged) {
      $0.authorizationStatus = .denied
    }
    await store.receive(\.locationResolved)
    await store.receive(\.fetchRequested) {
      $0.hasAttemptedFetch = true
    }
    await store.receive(\.fetchResponse.success) {
      $0.isLoading = false
      $0.dispensaries = fetched
    }
  }

  func test_authorizationDenied_doesNotAutoFetch() async {
    let store = TestStore(initialState: DispensaryFeedFeature.State()) {
      DispensaryFeedFeature()
    } withDependencies: {
      $0.catalogCacheClient = .unimplemented
      $0.catalogAPIClient = .unimplemented
      $0.locationClient = .test(status: .denied)
      $0.date = .constant(Date(timeIntervalSince1970: 1_780_000_000))
    }

    await store.send(.authorizationStatusResolved(.denied)) {
      $0.authorizationStatus = .denied
    }
  }

  // MARK: - .continueWithoutLocationTapped

  func test_continueWithoutLocation_clearsCoordinateAndFetches() async {
    let fetched = [Self.makeDispensary(legalName: "Standalone")]
    var api = CatalogAPIClient.unimplemented
    api.listDispensaries = { passed in
      XCTAssertNil(passed, "Continue-without should send nil coordinate.")
      return fetched
    }

    let store = TestStore(
      initialState: DispensaryFeedFeature.State(
        coordinate: Coordinate(latitude: 1, longitude: 2)
      )
    ) {
      DispensaryFeedFeature()
    } withDependencies: {
      $0.catalogCacheClient = .unimplemented
      $0.catalogAPIClient = api
      $0.locationClient = .test(status: .denied)
      $0.date = .constant(Date(timeIntervalSince1970: 1_780_000_000))
    }

    await store.send(.continueWithoutLocationTapped) {
      $0.coordinate = nil
    }
    await store.receive(\.fetchRequested) {
      $0.isLoading = true
      $0.error = nil
      $0.hasAttemptedFetch = true
    }
    await store.receive(\.fetchResponse.success) {
      $0.isLoading = false
      $0.dispensaries = fetched
    }
  }

  // MARK: - fetch failure paths

  func test_fetchFailure_withCachedData_keepsDataShowsOfflineBanner() async {
    let cached = [Self.makeDispensary(legalName: "From Cache")]
    var api = CatalogAPIClient.unimplemented
    api.listDispensaries = { _ in throw CatalogAPIError.unimplemented("transport") }

    let store = TestStore(
      initialState: DispensaryFeedFeature.State(
        dispensaries: cached,
        isShowingFromCache: true
      )
    ) {
      DispensaryFeedFeature()
    } withDependencies: {
      $0.catalogCacheClient = .unimplemented
      $0.catalogAPIClient = api
      $0.locationClient = .test(status: .denied)
      $0.date = .constant(Date(timeIntervalSince1970: 1_780_000_000))
    }

    await store.send(.fetchRequested) {
      $0.isLoading = true
      $0.error = nil
      $0.hasAttemptedFetch = true
    }
    await store.receive(\.fetchResponse.failure) {
      $0.isLoading = false
      $0.isShowingFromCache = true
      $0.error = "Something went wrong loading dispensaries."
    }
    XCTAssertEqual(store.state.dispensaries, cached, "Cached payload should survive failure.")
  }

  func test_fetchFailure_malformedPayload_setsParserMessage() async {
    var api = CatalogAPIClient.unimplemented
    api.listDispensaries = { _ in throw CatalogAPIError.malformedPayload("Dispensary") }

    let store = TestStore(initialState: DispensaryFeedFeature.State()) {
      DispensaryFeedFeature()
    } withDependencies: {
      $0.catalogCacheClient = .unimplemented
      $0.catalogAPIClient = api
      $0.locationClient = .test(status: .denied)
      $0.date = .constant(Date(timeIntervalSince1970: 1_780_000_000))
    }

    await store.send(.fetchRequested) {
      $0.isLoading = true
      $0.error = nil
      $0.hasAttemptedFetch = true
    }
    await store.receive(\.fetchResponse.failure) {
      $0.isLoading = false
      $0.error = "Something didn't look right in the response. Try again."
    }
  }

  func test_fetchFailure_transportError_setsTransportMessage() async {
    struct StubURLError: Error {}
    var api = CatalogAPIClient.unimplemented
    api.listDispensaries = { _ in throw StubURLError() }

    let store = TestStore(initialState: DispensaryFeedFeature.State()) {
      DispensaryFeedFeature()
    } withDependencies: {
      $0.catalogCacheClient = .unimplemented
      $0.catalogAPIClient = api
      $0.locationClient = .test(status: .denied)
      $0.date = .constant(Date(timeIntervalSince1970: 1_780_000_000))
    }

    await store.send(.fetchRequested) {
      $0.isLoading = true
      $0.error = nil
      $0.hasAttemptedFetch = true
    }
    await store.receive(\.fetchResponse.failure) {
      $0.isLoading = false
      $0.error = "We couldn't reach DankDash. We're showing your last results."
    }
  }

  // MARK: - .pullToRefresh

  func test_pullToRefresh_redirectsToFetchRequested() async {
    let fetched = [Self.makeDispensary(legalName: "Refreshed")]
    var api = CatalogAPIClient.unimplemented
    api.listDispensaries = { _ in fetched }

    let store = TestStore(initialState: DispensaryFeedFeature.State()) {
      DispensaryFeedFeature()
    } withDependencies: {
      $0.catalogCacheClient = .unimplemented
      $0.catalogAPIClient = api
      $0.locationClient = .test(status: .denied)
      $0.date = .constant(Date(timeIntervalSince1970: 1_780_000_000))
    }

    await store.send(.pullToRefresh)
    await store.receive(\.fetchRequested) {
      $0.isLoading = true
      $0.error = nil
      $0.hasAttemptedFetch = true
    }
    await store.receive(\.fetchResponse.success) {
      $0.isLoading = false
      $0.dispensaries = fetched
    }
  }

  // MARK: - .dispensaryTapped emits delegate

  func test_dispensaryTapped_emitsDelegate() async {
    let id = UUID()
    let store = TestStore(initialState: DispensaryFeedFeature.State()) {
      DispensaryFeedFeature()
    } withDependencies: {
      $0.catalogCacheClient = .unimplemented
      $0.catalogAPIClient = .unimplemented
      $0.locationClient = .unimplemented
      $0.date = .constant(Date(timeIntervalSince1970: 1_780_000_000))
    }

    await store.send(.dispensaryTapped(id))
    await store.receive(\.delegate.openDispensary)
  }

  // MARK: - Section grouping

  func test_sections_emptyFeed_emitsNoSections() {
    let result = DispensaryFeedSection.sections(from: [])
    XCTAssertTrue(result.isEmpty)
  }

  func test_sections_openDispensary_goesToDeliveringNow() {
    let open = Self.makeDispensary(legalName: "Open Now", isOpenNow: true)
    let closed = Self.makeDispensary(legalName: "Closed", isOpenNow: false)

    let result = DispensaryFeedSection.sections(from: [open, closed])
    XCTAssertEqual(result.first?.kind, .deliveringNow)
    XCTAssertEqual(result.first?.dispensaries.map(\.legalName), ["Open Now"])
  }

  func test_sections_topRated_filtersAndSortsDescending() {
    let strong = Self.makeDispensary(legalName: "Strong", ratingAvg: Decimal(string: "4.9"))
    let solid = Self.makeDispensary(legalName: "Solid", ratingAvg: Decimal(string: "4.5"))
    let weak = Self.makeDispensary(legalName: "Weak", ratingAvg: Decimal(string: "4.3"))

    let result = DispensaryFeedSection.sections(from: [weak, solid, strong])
    let topRated = result.first { $0.kind == .topRated }
    XCTAssertEqual(topRated?.dispensaries.map(\.legalName), ["Strong", "Solid"])
  }

  func test_sections_newOnDankDash_filtersByCreatedAtWithin30Days() {
    let now = Date(timeIntervalSince1970: 1_780_000_000)
    let fresh = Self.makeDispensary(
      legalName: "Fresh",
      createdAt: now.addingTimeInterval(-60 * 60 * 24 * 5)
    )
    let stale = Self.makeDispensary(
      legalName: "Stale",
      createdAt: now.addingTimeInterval(-60 * 60 * 24 * 90)
    )

    let result = DispensaryFeedSection.sections(from: [stale, fresh], referenceDate: now)
    let newSection = result.first { $0.kind == .newOnDankDash }
    XCTAssertEqual(newSection?.dispensaries.map(\.legalName), ["Fresh"])
  }

  func test_sections_omitsEmptyCuratedRails() {
    let closed = Self.makeDispensary(
      legalName: "Closed",
      isOpenNow: false,
      ratingAvg: Decimal(string: "3.5"),
      createdAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
    let result = DispensaryFeedSection.sections(
      from: [closed],
      referenceDate: Date(timeIntervalSince1970: 1_780_000_000)
    )
    // A low-rated, old, closed store qualifies for none of the curated
    // rails, but the catch-all still surfaces it so it is never hidden.
    XCTAssertEqual(result.map(\.kind), [.allDispensaries])
    XCTAssertEqual(result.first?.dispensaries.map(\.legalName), ["Closed"])
  }

  func test_sections_allDispensariesCatchAllIsLastAndComplete() {
    let open = Self.makeDispensary(legalName: "Open Now", isOpenNow: true)
    let closed = Self.makeDispensary(
      legalName: "Closed",
      isOpenNow: false,
      ratingAvg: Decimal(string: "3.0"),
      createdAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
    let result = DispensaryFeedSection.sections(
      from: [open, closed],
      referenceDate: Date(timeIntervalSince1970: 1_780_000_000)
    )

    XCTAssertEqual(result.last?.kind, .allDispensaries, "Catch-all is always last.")
    XCTAssertEqual(
      Set(result.last?.dispensaries.map(\.legalName) ?? []),
      ["Open Now", "Closed"],
      "Catch-all carries every dispensary, featured or not."
    )
  }

  // MARK: - isClosingSoon edge cases

  func test_isClosingSoon_returnsFalseWhenClosed() {
    let dispensary = Self.makeDispensary(legalName: "X", isOpenNow: false)
    let result = DispensaryFeedSection.isClosingSoon(
      dispensary,
      referenceDate: Date(timeIntervalSince1970: 1_780_000_000),
      timeZone: TimeZone(identifier: "America/Chicago") ?? .gmt
    )
    XCTAssertFalse(result)
  }

  func test_isClosingSoon_trueWhen30MinFromClose() {
    let tz = TimeZone(identifier: "America/Chicago") ?? .gmt
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = tz
    var components = DateComponents()
    components.year = 2026
    components.month = 5
    components.day = 19 // Tuesday in 2026
    components.hour = 21 // 9pm local
    components.minute = 30
    guard let reference = calendar.date(from: components) else {
      return XCTFail("Could not build reference date")
    }

    let hours = DispensaryHours(
      mon: nil,
      tue: DayHours(openMinutes: 8 * 60, closeMinutes: 22 * 60), // 10pm close
      wed: nil, thu: nil, fri: nil, sat: nil, sun: nil
    )
    let dispensary = Self.makeDispensary(legalName: "Tuesday Late", isOpenNow: true, hours: hours)

    let result = DispensaryFeedSection.isClosingSoon(
      dispensary,
      referenceDate: reference,
      timeZone: tz
    )
    XCTAssertTrue(result, "30 minutes from close should be 'closing soon'.")
  }

  func test_isClosingSoon_falseWhen2HoursFromClose() {
    let tz = TimeZone(identifier: "America/Chicago") ?? .gmt
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = tz
    var components = DateComponents()
    components.year = 2026
    components.month = 5
    components.day = 19
    components.hour = 20 // 8pm local
    components.minute = 0
    guard let reference = calendar.date(from: components) else {
      return XCTFail("Could not build reference date")
    }

    let hours = DispensaryHours(
      mon: nil,
      tue: DayHours(openMinutes: 8 * 60, closeMinutes: 22 * 60), // 10pm close
      wed: nil, thu: nil, fri: nil, sat: nil, sun: nil
    )
    let dispensary = Self.makeDispensary(legalName: "Tuesday Late", isOpenNow: true, hours: hours)

    let result = DispensaryFeedSection.isClosingSoon(
      dispensary,
      referenceDate: reference,
      timeZone: tz
    )
    XCTAssertFalse(result, "2 hours from close should NOT be 'closing soon'.")
  }

  // MARK: - userMessage mapping

  func test_userMessage_mapsErrorsToHumanCopy() {
    XCTAssertTrue(DispensaryFeedFeature.userMessage(for: .transport).contains("couldn't reach"))
    XCTAssertTrue(DispensaryFeedFeature.userMessage(for: .malformedPayload).contains("didn't look right"))
    XCTAssertTrue(DispensaryFeedFeature.userMessage(for: .unknown).contains("Something went wrong"))
  }

  // MARK: - Helpers

  static func makeDispensary(
    legalName: String,
    isOpenNow: Bool = false,
    ratingAvg: Decimal? = nil,
    createdAt: Date = Date(timeIntervalSince1970: 1_780_000_000),
    hours: DispensaryHours = DispensaryHours(
      mon: nil, tue: nil, wed: nil, thu: nil, fri: nil, sat: nil, sun: nil
    )
  ) -> Dispensary {
    Dispensary(
      id: UUID(),
      legalName: legalName,
      dba: nil,
      licenseNumber: "MN-0001",
      licenseType: .microbusiness,
      addressLine1: "1 Main",
      addressLine2: nil,
      city: "Minneapolis",
      region: "MN",
      postalCode: "55401",
      location: Coordinate(latitude: 44.97, longitude: -93.26),
      deliveryPolygon: GeoPolygon(rings: []),
      hours: hours,
      phone: nil,
      email: nil,
      logoImageKey: nil,
      heroImageKey: nil,
      brandColorHex: nil,
      isAcceptingOrders: true,
      isOpenNow: isOpenNow,
      opensAt: nil,
      ratingAvg: ratingAvg,
      ratingCount: 0,
      status: .active,
      createdAt: createdAt,
      updatedAt: createdAt
    )
  }
}
