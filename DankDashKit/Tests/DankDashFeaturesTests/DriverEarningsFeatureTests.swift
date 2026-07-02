import XCTest
import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

@MainActor
final class DriverEarningsFeatureTests: XCTestCase {

  // MARK: - onAppear

  func test_onAppear_firstLoad_fetchesEarningsAndShifts() async {
    let earnings = Self.earnings(.today, totalCents: 4_500, deliveries: 3)
    let shifts = [Self.shift(totalEarningsCents: 4_500, totalDeliveries: 3)]
    let store = TestStore(initialState: DriverEarningsFeature.State()) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverAppAPIClient = DriverAppAPIClient(
        getMe: { throw DriverAPIError.unimplemented("getMe") },
        getCurrentRoute: { throw DriverAPIError.unimplemented("getCurrentRoute") },
        getEarnings: { _ in earnings },
        getShifts: { shifts }
      )
    }
    store.exhaustivity = .off

    await store.send(.onAppear) {
      $0.isLoadingEarnings = true
      $0.isLoadingShifts = true
    }
    await store.skipReceivedActions()
    XCTAssertEqual(store.state.earnings, earnings)
    XCTAssertEqual(store.state.shifts, shifts)
    XCTAssertFalse(store.state.isLoadingEarnings)
    XCTAssertFalse(store.state.isLoadingShifts)
    await store.finish()
  }

  func test_onAppear_alreadyLoaded_isNoOp() async {
    let earnings = Self.earnings(.today, totalCents: 4_500, deliveries: 3)
    let store = TestStore(
      initialState: DriverEarningsFeature.State(
        earnings: earnings,
        shifts: [Self.shift()]
      )
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.onAppear)
  }

  // MARK: - Period change

  func test_periodChanged_clearsContentAndRefetches() async {
    let weekEarnings = Self.earnings(.week, totalCents: 18_000, deliveries: 12)
    let weekShifts = [Self.shift(), Self.shift()]
    let store = TestStore(
      initialState: DriverEarningsFeature.State(
        period: .today,
        earnings: Self.earnings(.today, totalCents: 4_500, deliveries: 3),
        shifts: [Self.shift()]
      )
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverAppAPIClient = DriverAppAPIClient(
        getMe: { throw DriverAPIError.unimplemented("getMe") },
        getCurrentRoute: { throw DriverAPIError.unimplemented("getCurrentRoute") },
        getEarnings: { _ in weekEarnings },
        getShifts: { weekShifts }
      )
    }
    store.exhaustivity = .off

    await store.send(.periodChanged(.week)) {
      $0.period = .week
      $0.earnings = nil
      $0.shifts = []
      $0.isLoadingEarnings = true
      $0.isLoadingShifts = true
    }
    await store.skipReceivedActions()
    XCTAssertEqual(store.state.earnings, weekEarnings)
    XCTAssertEqual(store.state.shifts, weekShifts)
  }

  func test_periodChanged_sameValue_isNoOp() async {
    let store = TestStore(
      initialState: DriverEarningsFeature.State(period: .today)
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.periodChanged(.today))
  }

  // MARK: - Pull-to-refresh

  func test_pullToRefresh_fetchesBoth() async {
    let earnings = Self.earnings(.today, totalCents: 6_000, deliveries: 4)
    let shifts = [Self.shift()]
    let store = TestStore(
      initialState: DriverEarningsFeature.State(
        earnings: Self.earnings(.today, totalCents: 4_500, deliveries: 3),
        shifts: []
      )
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverAppAPIClient = DriverAppAPIClient(
        getMe: { throw DriverAPIError.unimplemented("getMe") },
        getCurrentRoute: { throw DriverAPIError.unimplemented("getCurrentRoute") },
        getEarnings: { _ in earnings },
        getShifts: { shifts }
      )
    }
    store.exhaustivity = .off

    await store.send(.pullToRefresh) {
      $0.isRefreshing = true
    }
    await store.skipReceivedActions()
    XCTAssertFalse(store.state.isRefreshing, "isRefreshing flips off after both fetches resolve")
    XCTAssertEqual(store.state.earnings, earnings)
    XCTAssertEqual(store.state.shifts, shifts)
  }

  func test_pullToRefresh_whileLoading_isNoOp() async {
    let store = TestStore(
      initialState: DriverEarningsFeature.State(isLoadingEarnings: true)
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.pullToRefresh)
  }

  // MARK: - Failure paths

  func test_earningsLoaded_serverError_surfacesBanner() async {
    let envelope = ErrorEnvelope(error: .init(code: "INTERNAL", message: "Down for maintenance"))
    let store = TestStore(
      initialState: DriverEarningsFeature.State(
        isLoadingEarnings: true,
        isLoadingShifts: false
      )
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(
      .earningsLoaded(
        .failure(EarningsErrorBox(APIError.server(status: 500, envelope: envelope)))
      )
    ) {
      $0.isLoadingEarnings = false
      $0.errorBanner = "Down for maintenance"
    }
  }

  func test_earningsLoaded_endpointNotYetAvailable_suppressesBanner() async {
    let store = TestStore(
      initialState: DriverEarningsFeature.State(isLoadingEarnings: true)
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(
      .earningsLoaded(
        .failure(EarningsErrorBox(DriverAppAPIError.endpointNotYetAvailable))
      )
    ) {
      $0.isLoadingEarnings = false
    }
    XCTAssertNil(store.state.errorBanner)
  }

  func test_shiftsLoaded_failureWithExistingBanner_doesNotOverwrite() async {
    let store = TestStore(
      initialState: DriverEarningsFeature.State(
        isLoadingShifts: true,
        errorBanner: "Down for maintenance"
      )
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(
      .shiftsLoaded(
        .failure(EarningsErrorBox(DriverAPIError.unimplemented("getShifts")))
      )
    ) {
      $0.isLoadingShifts = false
    }
    XCTAssertEqual(store.state.errorBanner, "Down for maintenance", "earnings banner sticks; shifts failure doesn't overwrite it")
  }

  // MARK: - Retry

  func test_retryTapped_withBanner_refetches() async {
    let earnings = Self.earnings(.today, totalCents: 4_500, deliveries: 3)
    let shifts = [Self.shift()]
    let store = TestStore(
      initialState: DriverEarningsFeature.State(errorBanner: "Down for maintenance")
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverAppAPIClient = DriverAppAPIClient(
        getMe: { throw DriverAPIError.unimplemented("getMe") },
        getCurrentRoute: { throw DriverAPIError.unimplemented("getCurrentRoute") },
        getEarnings: { _ in earnings },
        getShifts: { shifts }
      )
    }
    store.exhaustivity = .off

    await store.send(.retryTapped) {
      $0.isLoadingEarnings = true
      $0.isLoadingShifts = true
      $0.errorBanner = nil
    }
    await store.skipReceivedActions()
    XCTAssertEqual(store.state.earnings, earnings)
  }

  func test_retryTapped_withoutBanner_isNoOp() async {
    let store = TestStore(initialState: DriverEarningsFeature.State()) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.retryTapped)
  }

  // MARK: - Misc UI

  func test_errorBannerDismissed_clearsBanner() async {
    let store = TestStore(
      initialState: DriverEarningsFeature.State(errorBanner: "oops")
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.errorBannerDismissed) {
      $0.errorBanner = nil
    }
  }

  func test_shiftRowTapped_firesDelegate() async {
    let shiftId = UUID()
    let store = TestStore(initialState: DriverEarningsFeature.State()) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.shiftRowTapped(shiftId))
    await store.receive(\.delegate.openShiftDetail)
  }

  // MARK: - State helpers

  func test_isInitialLoading_requiresEmptyContent() {
    var state = DriverEarningsFeature.State(isLoadingEarnings: true)
    XCTAssertTrue(state.isInitialLoading)
    state.earnings = Self.earnings(.today, totalCents: 1, deliveries: 1)
    XCTAssertFalse(state.isInitialLoading, "any content suppresses the initial-loading spinner")
  }

  // MARK: - Cashout flow

  func test_cashoutCtaTapped_opensSheet() async {
    let store = TestStore(initialState: DriverEarningsFeature.State()) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.cashoutCtaTapped) {
      $0.cashoutSheet = DriverEarningsFeature.CashoutSheetState()
    }
  }

  func test_cashoutCtaTapped_whileSheetOpen_isNoOp() async {
    let store = TestStore(
      initialState: DriverEarningsFeature.State(
        cashoutSheet: DriverEarningsFeature.CashoutSheetState(amountText: "10")
      )
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.cashoutCtaTapped)
  }

  func test_cashoutAmountChanged_updatesAmountAndClearsError() async {
    let store = TestStore(
      initialState: DriverEarningsFeature.State(
        cashoutSheet: DriverEarningsFeature.CashoutSheetState(
          amountText: "0",
          errorMessage: "Not enough available."
        )
      )
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.cashoutAmountChanged("25.50")) {
      $0.cashoutSheet?.amountText = "25.50"
      $0.cashoutSheet?.errorMessage = nil
    }
  }

  func test_cashoutAmountChanged_withoutSheet_isNoOp() async {
    let store = TestStore(initialState: DriverEarningsFeature.State()) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.cashoutAmountChanged("10"))
  }

  func test_cashoutConfirmed_happyPath_closesSheetAndShowsToast() async {
    let cashout = Self.cashoutFixture(amountCents: 2_500, status: .pending)
    let captured = Locker<[Int]>([])
    let store = TestStore(
      initialState: DriverEarningsFeature.State(
        earnings: Self.earnings(.today, totalCents: 4_500, deliveries: 3),
        shifts: [Self.shift()],
        cashoutSheet: DriverEarningsFeature.CashoutSheetState(amountText: "25.00")
      )
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverCashoutAPIClient = DriverCashoutAPIClient(
        requestCashout: { amount in
          await captured.append(amount)
          return cashout
        }
      )
      $0.driverAppAPIClient = DriverAppAPIClient(
        getMe: { throw DriverAPIError.unimplemented("getMe") },
        getCurrentRoute: { throw DriverAPIError.unimplemented("getCurrentRoute") },
        getEarnings: { _ in Self.earnings(.today, totalCents: 2_000, deliveries: 3) },
        getShifts: { [Self.shift()] }
      )
    }
    store.exhaustivity = .off

    await store.send(.cashoutConfirmed) {
      $0.cashoutSheet?.isSubmitting = true
    }
    await store.skipReceivedActions()
    XCTAssertNil(store.state.cashoutSheet, "sheet dismissed after server success")
    XCTAssertEqual(store.state.cashoutToast, "Cashout requested. We'll send it to your bank.")
    XCTAssertEqual(store.state.recentCashouts.first, cashout)
    let recordedAmounts = await captured.value
    XCTAssertEqual(recordedAmounts, [2_500], "POST body uses parsed integer cents")
  }

  func test_cashoutConfirmed_insufficientFunds_keepsSheetWithInlineError() async {
    let envelope = ErrorEnvelope(
      error: .init(
        code: "PAYMENT_AMOUNT_MISMATCH",
        message: "requested cashout exceeds available balance",
        details: .object([
          "requestedCents": .number(10_000),
          "availableCents": .number(1_500),
          "lifetimeCents": .number(2_000),
          "outstandingCents": .number(500)
        ])
      )
    )
    let store = TestStore(
      initialState: DriverEarningsFeature.State(
        cashoutSheet: DriverEarningsFeature.CashoutSheetState(amountText: "100.00")
      )
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverCashoutAPIClient = DriverCashoutAPIClient(
        requestCashout: { _ in
          throw APIError.server(status: 422, envelope: envelope)
        }
      )
    }
    store.exhaustivity = .off

    await store.send(.cashoutConfirmed) {
      $0.cashoutSheet?.isSubmitting = true
    }
    await store.skipReceivedActions()
    XCTAssertNotNil(store.state.cashoutSheet, "sheet stays open on insufficient funds")
    XCTAssertFalse(store.state.cashoutSheet?.isSubmitting ?? true)
    XCTAssertEqual(
      store.state.cashoutSheet?.errorMessage,
      "Not enough available. You have $15.00 to cash out."
    )
    XCTAssertNil(store.state.cashoutToast, "no success toast on failure")
  }

  func test_cashoutConfirmed_serverError_surfacesGenericMessage() async {
    let envelope = ErrorEnvelope(
      error: .init(code: "INTERNAL", message: "Try again later")
    )
    let store = TestStore(
      initialState: DriverEarningsFeature.State(
        cashoutSheet: DriverEarningsFeature.CashoutSheetState(amountText: "10.00")
      )
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverCashoutAPIClient = DriverCashoutAPIClient(
        requestCashout: { _ in
          throw APIError.server(status: 500, envelope: envelope)
        }
      )
    }
    store.exhaustivity = .off

    await store.send(.cashoutConfirmed) {
      $0.cashoutSheet?.isSubmitting = true
    }
    await store.skipReceivedActions()
    XCTAssertEqual(store.state.cashoutSheet?.errorMessage, "Try again later")
    XCTAssertFalse(store.state.cashoutSheet?.isSubmitting ?? true)
  }

  func test_cashoutConfirmed_invalidAmount_isNoOp() async {
    let store = TestStore(
      initialState: DriverEarningsFeature.State(
        cashoutSheet: DriverEarningsFeature.CashoutSheetState(amountText: "abc")
      )
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.cashoutConfirmed)
  }

  func test_cashoutConfirmed_whileSubmitting_isNoOp() async {
    let store = TestStore(
      initialState: DriverEarningsFeature.State(
        cashoutSheet: DriverEarningsFeature.CashoutSheetState(
          amountText: "10.00",
          isSubmitting: true
        )
      )
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.cashoutConfirmed)
  }

  func test_cashoutSheetDismissed_clearsSheet() async {
    let store = TestStore(
      initialState: DriverEarningsFeature.State(
        cashoutSheet: DriverEarningsFeature.CashoutSheetState(amountText: "10.00")
      )
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.cashoutSheetDismissed) {
      $0.cashoutSheet = nil
    }
  }

  func test_cashoutToastDismissed_clearsToast() async {
    let store = TestStore(
      initialState: DriverEarningsFeature.State(cashoutToast: "Cashout requested.")
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }
    await store.send(.cashoutToastDismissed) {
      $0.cashoutToast = nil
    }
  }

  func test_cashoutResponseSuccess_firesDelegate() async {
    let cashout = Self.cashoutFixture(amountCents: 1_500, status: .processing)
    let store = TestStore(
      initialState: DriverEarningsFeature.State(
        earnings: Self.earnings(.today, totalCents: 4_500, deliveries: 3),
        cashoutSheet: DriverEarningsFeature.CashoutSheetState(
          amountText: "15.00",
          isSubmitting: true
        )
      )
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverAppAPIClient = DriverAppAPIClient(
        getMe: { throw DriverAPIError.unimplemented("getMe") },
        getCurrentRoute: { throw DriverAPIError.unimplemented("getCurrentRoute") },
        getEarnings: { _ in Self.earnings(.today, totalCents: 3_000, deliveries: 3) },
        getShifts: { [] }
      )
    }
    store.exhaustivity = .off

    await store.send(.cashoutResponse(.success(cashout)))
    await store.receive(\.delegate.cashoutSucceeded)
    XCTAssertEqual(store.state.recentCashouts.first?.id, cashout.id)
  }

  // MARK: - CashoutSheetState parsing

  func test_parsedAmountCents_acceptsDollarsAndCents() {
    XCTAssertEqual(DriverEarningsFeature.CashoutSheetState(amountText: "25").parsedAmountCents, 2_500)
    XCTAssertEqual(DriverEarningsFeature.CashoutSheetState(amountText: "25.5").parsedAmountCents, 2_550)
    XCTAssertEqual(DriverEarningsFeature.CashoutSheetState(amountText: "25.50").parsedAmountCents, 2_550)
    XCTAssertEqual(DriverEarningsFeature.CashoutSheetState(amountText: "$25.00").parsedAmountCents, 2_500)
    XCTAssertEqual(DriverEarningsFeature.CashoutSheetState(amountText: " 10 ").parsedAmountCents, 1_000)
  }

  func test_parsedAmountCents_rejectsInvalid() {
    XCTAssertNil(DriverEarningsFeature.CashoutSheetState(amountText: "").parsedAmountCents)
    XCTAssertNil(DriverEarningsFeature.CashoutSheetState(amountText: "abc").parsedAmountCents)
    XCTAssertNil(DriverEarningsFeature.CashoutSheetState(amountText: "0").parsedAmountCents)
    XCTAssertNil(DriverEarningsFeature.CashoutSheetState(amountText: "-5").parsedAmountCents)
  }

  func test_isConfirmEnabled_requiresValidAmountAndNotSubmitting() {
    XCTAssertTrue(DriverEarningsFeature.CashoutSheetState(amountText: "10").isConfirmEnabled)
    XCTAssertFalse(DriverEarningsFeature.CashoutSheetState(amountText: "").isConfirmEnabled)
    XCTAssertFalse(
      DriverEarningsFeature.CashoutSheetState(amountText: "10", isSubmitting: true).isConfirmEnabled
    )
  }

  // MARK: - Bank linking

  func test_bankLinkStatusResponse_setsLinkedFlag() async {
    let store = TestStore(initialState: DriverEarningsFeature.State()) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.bankLinkStatusResponse(.success(true))) {
      $0.isBankLinked = true
    }
    XCTAssertFalse(store.state.needsBankLink)

    await store.send(.bankLinkStatusResponse(.success(false))) {
      $0.isBankLinked = false
    }
    XCTAssertTrue(store.state.needsBankLink)
  }

  func test_bankLinkStatusResponse_failure_leavesFlagUnknown() async {
    let envelope = ErrorEnvelope(error: .init(code: "INTERNAL", message: "nope"))
    let store = TestStore(initialState: DriverEarningsFeature.State()) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(
      .bankLinkStatusResponse(.failure(EarningsErrorBox(APIError.server(status: 500, envelope: envelope))))
    )
    XCTAssertNil(store.state.isBankLinked)
    XCTAssertFalse(store.state.needsBankLink, "unknown status never shows the CTA")
  }

  func test_onAppear_fetchesBankStatus() async {
    let store = TestStore(initialState: DriverEarningsFeature.State()) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverAppAPIClient = DriverAppAPIClient(
        getMe: { throw DriverAPIError.unimplemented("getMe") },
        getCurrentRoute: { throw DriverAPIError.unimplemented("getCurrentRoute") },
        getEarnings: { _ in Self.earnings(.today, totalCents: 4_500, deliveries: 3) },
        getShifts: { [Self.shift()] }
      )
      $0.driverPayoutAccountAPIClient = DriverPayoutAccountAPIClient(
        getStatus: { false },
        startLink: { throw DriverAPIError.unimplemented("startLink") }
      )
    }
    store.exhaustivity = .off

    await store.send(.onAppear)
    await store.skipReceivedActions()
    XCTAssertEqual(store.state.isBankLinked, false)
    XCTAssertTrue(store.state.needsBankLink)
    await store.finish()
  }

  func test_linkBankTapped_startsSessionAndPresents() async {
    let session = Self.linkSession()
    let store = TestStore(
      initialState: DriverEarningsFeature.State(isBankLinked: false)
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverPayoutAccountAPIClient = DriverPayoutAccountAPIClient(
        getStatus: { false },
        startLink: { session }
      )
    }

    await store.send(.linkBankTapped) {
      $0.isStartingBankLink = true
    }
    await store.receive(\.bankLinkStarted.success) {
      $0.isStartingBankLink = false
      $0.bankLinkSession = session
    }
  }

  func test_linkBankTapped_whileStarting_isNoOp() async {
    let store = TestStore(
      initialState: DriverEarningsFeature.State(isBankLinked: false, isStartingBankLink: true)
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(.linkBankTapped)
  }

  func test_linkBankStarted_failure_surfacesBanner() async {
    let envelope = ErrorEnvelope(error: .init(code: "PAYMENT_PROVIDER_UNAVAILABLE", message: "Bank linking is down"))
    let store = TestStore(
      initialState: DriverEarningsFeature.State(isBankLinked: false, isStartingBankLink: true)
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
    }

    await store.send(
      .bankLinkStarted(.failure(EarningsErrorBox(APIError.server(status: 503, envelope: envelope))))
    ) {
      $0.isStartingBankLink = false
      $0.errorBanner = "Bank linking is down"
    }
  }

  func test_bankLinkSheetDismissed_clearsSessionAndReloadsStatus() async {
    let session = Self.linkSession()
    let store = TestStore(
      initialState: DriverEarningsFeature.State(isBankLinked: false, bankLinkSession: session)
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverPayoutAccountAPIClient = DriverPayoutAccountAPIClient(
        getStatus: { true },
        startLink: { throw DriverAPIError.unimplemented("startLink") }
      )
    }

    await store.send(.bankLinkSheetDismissed) {
      $0.bankLinkSession = nil
    }
    await store.receive(\.bankLinkStatusResponse.success) {
      $0.isBankLinked = true
    }
  }

  func test_cashoutConfirmed_bankNotLinked_closesSheetAndShowsLinkCTA() async {
    let envelope = ErrorEnvelope(
      error: .init(
        code: "PAYMENT_METHOD_INVALID",
        message: "link a bank account before cashing out",
        details: .object(["reason": .string("driver_bank_account_not_linked")])
      )
    )
    let store = TestStore(
      initialState: DriverEarningsFeature.State(
        cashoutSheet: DriverEarningsFeature.CashoutSheetState(amountText: "10.00")
      )
    ) {
      DriverEarningsFeature()
    } withDependencies: {
      Self.disableDependencies(&$0)
      $0.driverCashoutAPIClient = DriverCashoutAPIClient(
        requestCashout: { _ in throw APIError.server(status: 422, envelope: envelope) }
      )
    }
    store.exhaustivity = .off

    await store.send(.cashoutConfirmed) {
      $0.cashoutSheet?.isSubmitting = true
    }
    await store.skipReceivedActions()
    XCTAssertNil(store.state.cashoutSheet, "sheet closes so the link CTA is visible")
    XCTAssertEqual(store.state.isBankLinked, false)
    XCTAssertTrue(store.state.needsBankLink)
    XCTAssertEqual(store.state.errorBanner, "Link a bank account to cash out your earnings.")
  }

  // MARK: - Fixtures

  nonisolated private static func earnings(
    _ period: EarningsPeriod,
    totalCents: Int,
    deliveries: Int
  ) -> DriverEarnings {
    DriverEarnings(
      period: period,
      since: Date(timeIntervalSince1970: 1_699_956_000),
      until: Date(timeIntervalSince1970: 1_700_042_400),
      tipsCents: totalCents / 3,
      deliveryFeesCents: (totalCents * 2) / 3,
      deliveriesCount: deliveries,
      totalCents: totalCents
    )
  }

  nonisolated private static func shift(
    totalEarningsCents: Int = 1_500,
    totalDeliveries: Int = 1
  ) -> DriverShift {
    DriverShift(
      id: UUID(),
      driverId: UUID(uuidString: "00000000-0000-0000-0000-0000000000d1")!,
      startedAt: Date(timeIntervalSince1970: 1_700_000_000),
      endedAt: Date(timeIntervalSince1970: 1_700_003_600),
      startingLocation: Coordinate(latitude: 44.97, longitude: -93.26),
      endingLocation: Coordinate(latitude: 44.97, longitude: -93.26),
      totalMiles: Decimal(string: "6.2"),
      totalDeliveries: totalDeliveries,
      totalEarningsCents: totalEarningsCents
    )
  }

  nonisolated private static func cashoutFixture(
    id: UUID = UUID(uuidString: "00000000-0000-0000-0000-0000000000c1")!,
    amountCents: Int = 2_500,
    status: CashoutStatus = .pending,
    aeropayPayoutRef: String? = nil
  ) -> CashoutRequest {
    CashoutRequest(
      id: id,
      amountCents: amountCents,
      status: status,
      requestedAt: Date(timeIntervalSince1970: 1_700_000_000),
      aeropayPayoutRef: aeropayPayoutRef
    )
  }

  nonisolated private static func linkSession(
    id: String = "link_session_driver_1"
  ) -> AeropayLinkSession {
    AeropayLinkSession(
      id: id,
      hostedUrl: URL(string: "https://link.aeropay.com/session/\(id)")!,
      expiresAt: Date(timeIntervalSince1970: 1_700_003_600)
    )
  }

  static func disableDependencies(_ values: inout DependencyValues) {
    values.driverAppAPIClient = .unimplemented
    values.driverCashoutAPIClient = .unimplemented
    values.driverPayoutAccountAPIClient = .unimplemented
    values.continuousClock = ImmediateClock()
    values.date = .constant(Date(timeIntervalSince1970: 1_700_000_000))
  }
}

/// Actor-isolated capture helper for verifying side-effects (POST
/// arguments) from inside a `@Sendable` test closure. Mirrors the
/// `Locker<T>` pattern used in other feature tests.
private actor Locker<T: Sendable> {
  private var storage: T

  init(_ initial: T) {
    self.storage = initial
  }

  var value: T { storage }

  func set(_ next: T) {
    storage = next
  }
}

private extension Locker where T == [Int] {
  func append(_ next: Int) {
    var next1 = value
    next1.append(next)
    set(next1)
  }
}
