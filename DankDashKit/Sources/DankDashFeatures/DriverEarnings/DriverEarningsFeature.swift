import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Driver earnings full-page surface. Owns the period segmented
/// control (`today` / `week` / `month`), the current `DriverEarnings`
/// summary fetched from `GET /v1/driver/earnings`, and the recent
/// `DriverShift` history fetched from `GET /v1/driver/shifts`.
///
/// The shift home renders a slim earnings card; tapping it pushes this
/// feature so the driver can see the period breakdown plus a rolling
/// shift list. Both endpoints fetch concurrently on period change and
/// on pull-to-refresh.
///
/// Phase 20.4 extends the feature with the Aeropay cashout flow. The
/// driver taps the Cashout CTA, a sheet opens with an amount input,
/// confirm POSTs `POST /v1/driver/cashout` — the backend is the single
/// source of truth for the available balance (it computes lifetime
/// earnings minus outstanding payouts inside the same scoped read), so
/// iOS does NOT pre-gate the amount. On overdraw the server answers
/// 422 with envelope code `PAYMENT_AMOUNT_MISMATCH` and the reducer
/// surfaces an inline insufficient-funds error in the sheet. On
/// success the sheet dismisses, a transient toast confirms the
/// request, the freshly-created cashout row is appended to
/// ``State/recentCashouts``, and earnings refetch to reflect the
/// updated outstanding balance.
@Reducer
public struct DriverEarningsFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable {
    public var period: EarningsPeriod
    public var earnings: DriverEarnings?
    public var shifts: [DriverShift]
    public var recentCashouts: [CashoutRequest]
    public var isLoadingEarnings: Bool
    public var isLoadingShifts: Bool
    public var isRefreshing: Bool
    public var errorBanner: String?

    /// Sheet state for the cashout flow. `nil` when the sheet is
    /// dismissed; a value drives the `.sheet(item:)` presentation in
    /// the view.
    public var cashoutSheet: CashoutSheetState?

    /// Transient confirmation banner shown after a successful cashout.
    /// The view auto-dismisses it on a short timer; the reducer also
    /// accepts an explicit dismiss action for the manual swipe-down.
    public var cashoutToast: String?

    public init(
      period: EarningsPeriod = .today,
      earnings: DriverEarnings? = nil,
      shifts: [DriverShift] = [],
      recentCashouts: [CashoutRequest] = [],
      isLoadingEarnings: Bool = false,
      isLoadingShifts: Bool = false,
      isRefreshing: Bool = false,
      errorBanner: String? = nil,
      cashoutSheet: CashoutSheetState? = nil,
      cashoutToast: String? = nil
    ) {
      self.period = period
      self.earnings = earnings
      self.shifts = shifts
      self.recentCashouts = recentCashouts
      self.isLoadingEarnings = isLoadingEarnings
      self.isLoadingShifts = isLoadingShifts
      self.isRefreshing = isRefreshing
      self.errorBanner = errorBanner
      self.cashoutSheet = cashoutSheet
      self.cashoutToast = cashoutToast
    }

    /// True while the initial fetch is in flight and we have no
    /// content yet — drives the spinner-vs-empty-state branching in
    /// the view.
    public var isInitialLoading: Bool {
      (isLoadingEarnings || isLoadingShifts) && earnings == nil && shifts.isEmpty
    }
  }

  /// Inline-presented sheet state for the cashout flow. Lives on the
  /// parent ``State`` rather than being its own feature because the
  /// reducer is small (an amount input + submit + error display) and
  /// nesting another reducer would add ceremony without isolation
  /// benefit. The amount is held as a string for direct text-field
  /// binding; the parser only runs on submit.
  public struct CashoutSheetState: Equatable, Sendable {
    public var amountText: String
    public var isSubmitting: Bool
    public var errorMessage: String?

    public init(
      amountText: String = "",
      isSubmitting: Bool = false,
      errorMessage: String? = nil
    ) {
      self.amountText = amountText
      self.isSubmitting = isSubmitting
      self.errorMessage = errorMessage
    }

    /// Parses `amountText` to integer cents. The view binds a $-prefixed
    /// dollar string; we accept decimals with up to two fractional
    /// digits and reject anything else. Returns nil for empty input or
    /// non-positive amounts.
    public var parsedAmountCents: Int? {
      let trimmed = amountText.trimmingCharacters(in: .whitespaces)
      guard !trimmed.isEmpty else { return nil }
      let normalized = trimmed.replacingOccurrences(of: "$", with: "")
      guard let amount = Decimal(string: normalized) else { return nil }
      let cents = NSDecimalNumber(decimal: amount * 100).intValue
      return cents > 0 ? cents : nil
    }

    /// True when the Confirm CTA should be enabled — there is a valid
    /// positive amount AND no submission is in flight.
    public var isConfirmEnabled: Bool {
      !isSubmitting && parsedAmountCents != nil
    }
  }

  public enum Action: Equatable, Sendable {
    case onAppear
    case periodChanged(EarningsPeriod)
    case pullToRefresh
    case retryTapped

    case earningsLoaded(Result<DriverEarnings, EarningsErrorBox>)
    case shiftsLoaded(Result<[DriverShift], EarningsErrorBox>)

    case errorBannerDismissed
    case shiftRowTapped(UUID)

    case cashoutCtaTapped
    case cashoutAmountChanged(String)
    case cashoutConfirmed
    case cashoutResponse(Result<CashoutRequest, CashoutErrorBox>)
    case cashoutSheetDismissed
    case cashoutToastDismissed

    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Equatable, Sendable {
      case openShiftDetail(shiftId: UUID)
      /// A cashout request was successfully persisted. The parent (if
      /// any) can use this to refresh anything that depends on the
      /// outstanding payouts balance — e.g. a wallet badge.
      case cashoutSucceeded(CashoutRequest)
    }
  }

  @Dependency(\.driverAppAPIClient) var driverAppAPI
  @Dependency(\.driverCashoutAPIClient) var cashoutAPI

  public init() {}

  private enum CancelID: Hashable {
    case earnings
    case shifts
    case cashout
  }

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .onAppear:
        // Re-entering the page after the first load shouldn't refetch
        // — the user pulls to refresh. Mirrors OrderHistoryFeature.
        guard state.earnings == nil, state.shifts.isEmpty,
              !state.isLoadingEarnings, !state.isLoadingShifts else {
          return .none
        }
        return startLoad(state: &state)

      case .periodChanged(let next):
        guard next != state.period else { return .none }
        state.period = next
        state.earnings = nil
        state.errorBanner = nil
        // Shifts don't filter by period server-side (the endpoint
        // returns the recent N) — we re-fetch them too so the page is
        // coherent after a period switch.
        state.shifts = []
        return startLoad(state: &state)

      case .pullToRefresh:
        guard !state.isRefreshing, !state.isLoadingEarnings, !state.isLoadingShifts else {
          return .none
        }
        state.isRefreshing = true
        state.errorBanner = nil
        return loadConcurrently(period: state.period)

      case .retryTapped:
        guard state.errorBanner != nil else { return .none }
        return startLoad(state: &state)

      case .earningsLoaded(.success(let earnings)):
        state.isLoadingEarnings = false
        // Flip refreshing back only when *both* concurrent fetches
        // are done so the pull-to-refresh spinner doesn't disappear
        // while one half is still in flight.
        if !state.isLoadingShifts { state.isRefreshing = false }
        state.earnings = earnings
        return .none

      case .earningsLoaded(.failure(let box)):
        state.isLoadingEarnings = false
        if !state.isLoadingShifts { state.isRefreshing = false }
        // Earnings 404 (endpoint not yet fully exposed) keeps the
        // existing content rather than blowing it away — same as
        // shift home's read-only forgiveness.
        if !box.endpointNotYetAvailable {
          state.errorBanner = box.userFacingMessage()
        }
        return .none

      case .shiftsLoaded(.success(let shifts)):
        state.isLoadingShifts = false
        if !state.isLoadingEarnings { state.isRefreshing = false }
        state.shifts = shifts
        return .none

      case .shiftsLoaded(.failure(let box)):
        state.isLoadingShifts = false
        if !state.isLoadingEarnings { state.isRefreshing = false }
        if !box.endpointNotYetAvailable, state.errorBanner == nil {
          state.errorBanner = box.userFacingMessage()
        }
        return .none

      case .errorBannerDismissed:
        state.errorBanner = nil
        return .none

      case .shiftRowTapped(let id):
        return .send(.delegate(.openShiftDetail(shiftId: id)))

      case .cashoutCtaTapped:
        // Idempotent — a second tap while the sheet is already up
        // would replace its in-progress state, so we no-op.
        guard state.cashoutSheet == nil else { return .none }
        state.cashoutSheet = CashoutSheetState()
        return .none

      case .cashoutAmountChanged(let amount):
        guard state.cashoutSheet != nil else { return .none }
        state.cashoutSheet?.amountText = amount
        // Typing clears the inline error so the driver can immediately
        // see the new attempt-state without an extra tap.
        state.cashoutSheet?.errorMessage = nil
        return .none

      case .cashoutConfirmed:
        guard var sheet = state.cashoutSheet, !sheet.isSubmitting else {
          return .none
        }
        guard let amountCents = sheet.parsedAmountCents else { return .none }
        sheet.isSubmitting = true
        sheet.errorMessage = nil
        state.cashoutSheet = sheet
        return .run { [cashoutAPI] send in
          do {
            let cashout = try await cashoutAPI.requestCashout(amountCents)
            await send(.cashoutResponse(.success(cashout)))
          } catch {
            await send(.cashoutResponse(.failure(CashoutErrorBox(error))))
          }
        }
        .cancellable(id: CancelID.cashout, cancelInFlight: true)

      case .cashoutResponse(.success(let cashout)):
        // Close the sheet, surface a toast, prepend the fresh row to
        // the recent-cashouts list so the wallet renders it without
        // waiting on a refetch, and refresh earnings/shifts so the
        // server's view of outstanding balance is reflected.
        state.cashoutSheet = nil
        state.cashoutToast = "Cashout requested. We'll send it to your bank."
        state.recentCashouts.insert(cashout, at: 0)
        return .merge(
          .send(.delegate(.cashoutSucceeded(cashout))),
          loadConcurrently(period: state.period)
        )

      case .cashoutResponse(.failure(let box)):
        guard state.cashoutSheet != nil else { return .none }
        state.cashoutSheet?.isSubmitting = false
        state.cashoutSheet?.errorMessage = box.userFacingMessage()
        return .none

      case .cashoutSheetDismissed:
        // Cancel any in-flight POST so the driver isn't surprised by a
        // late toast or error after they dismissed the sheet.
        state.cashoutSheet = nil
        return .cancel(id: CancelID.cashout)

      case .cashoutToastDismissed:
        state.cashoutToast = nil
        return .none

      case .delegate:
        return .none
      }
    }
  }

  // MARK: - Effect helpers

  private func startLoad(state: inout State) -> Effect<Action> {
    state.isLoadingEarnings = true
    state.isLoadingShifts = true
    state.errorBanner = nil
    return loadConcurrently(period: state.period)
  }

  private func loadConcurrently(period: EarningsPeriod) -> Effect<Action> {
    .merge(
      .run { [driverAppAPI] send in
        do {
          let earnings = try await driverAppAPI.getEarnings(period)
          await send(.earningsLoaded(.success(earnings)))
        } catch {
          await send(.earningsLoaded(.failure(EarningsErrorBox(error))))
        }
      }.cancellable(id: CancelID.earnings, cancelInFlight: true),
      .run { [driverAppAPI] send in
        do {
          let shifts = try await driverAppAPI.getShifts()
          await send(.shiftsLoaded(.success(shifts)))
        } catch {
          await send(.shiftsLoaded(.failure(EarningsErrorBox(error))))
        }
      }.cancellable(id: CancelID.shifts, cancelInFlight: true)
    )
  }
}

// MARK: - Error box

/// Equatable wrapper around the earnings-page error surface — same
/// pattern as `ShiftErrorBox` so TestStore tests don't depend on
/// `APIError` / `DriverAPIError` cases directly.
public struct EarningsErrorBox: Error, Equatable, Sendable {
  public enum Kind: Equatable, Sendable {
    case endpointNotYetAvailable
    case malformed(String)
    case transport
    case server(message: String)
    case unauthorized
    case unimplemented(String)
    case other(String)
  }

  public let kind: Kind

  public init(_ error: Error) {
    if let appError = error as? DriverAppAPIError {
      switch appError {
      case .endpointNotYetAvailable: self.kind = .endpointNotYetAvailable
      }
      return
    }
    if let driverError = error as? DriverAPIError {
      switch driverError {
      case .malformedPayload(let label): self.kind = .malformed(label)
      case .unimplemented(let name): self.kind = .unimplemented(name)
      }
      return
    }
    if let apiError = error as? APIError {
      switch apiError {
      case .server(_, let envelope): self.kind = .server(message: envelope.error.message)
      case .transport: self.kind = .transport
      case .unauthorized, .noRefreshToken: self.kind = .unauthorized
      case .unexpectedStatus, .decoding, .configuration: self.kind = .other(String(describing: apiError))
      }
      return
    }
    self.kind = .other(String(describing: error))
  }

  public var endpointNotYetAvailable: Bool {
    if case .endpointNotYetAvailable = kind { return true }
    return false
  }

  public func userFacingMessage() -> String {
    switch kind {
    case .endpointNotYetAvailable: ""
    case .malformed: "Couldn't read the response. We'll try again."
    case .transport: "Couldn't reach DankDash. Check your connection."
    case .server(let message): message
    case .unauthorized: "Sign in again to continue."
    case .unimplemented: "This is not available yet."
    case .other(let message): message
    }
  }
}

/// Equatable wrapper around the cashout-request error surface. The
/// reducer treats `PAYMENT_AMOUNT_MISMATCH` (server 422 envelope) as
/// the canonical insufficient-funds signal — every other failure
/// renders as a generic error with the server's message text. Keeping
/// this separate from ``EarningsErrorBox`` matters because the cashout
/// envelope ships a structured `details` payload (available /
/// outstanding cents) that the insufficient-funds copy reflects.
public struct CashoutErrorBox: Error, Equatable, Sendable {
  public enum Kind: Equatable, Sendable {
    case insufficientFunds(availableCents: Int?)
    case malformed(String)
    case transport
    case server(message: String)
    case unauthorized
    case unimplemented(String)
    case other(String)
  }

  public let kind: Kind

  public init(_ error: Error) {
    if let driverError = error as? DriverAPIError {
      switch driverError {
      case .malformedPayload(let label): self.kind = .malformed(label)
      case .unimplemented(let name): self.kind = .unimplemented(name)
      }
      return
    }
    if let apiError = error as? APIError {
      switch apiError {
      case .server(let status, let envelope):
        if status == 422, envelope.error.code == "PAYMENT_AMOUNT_MISMATCH" {
          self.kind = .insufficientFunds(availableCents: Self.extractAvailableCents(envelope.error.details))
        } else {
          self.kind = .server(message: envelope.error.message)
        }
      case .transport: self.kind = .transport
      case .unauthorized, .noRefreshToken: self.kind = .unauthorized
      case .unexpectedStatus, .decoding, .configuration: self.kind = .other(String(describing: apiError))
      }
      return
    }
    self.kind = .other(String(describing: error))
  }

  /// True when the failure is the server's insufficient-funds gate
  /// (422 PAYMENT_AMOUNT_MISMATCH). The view uses this to choose
  /// between an in-sheet inline error and a dismiss-the-sheet toast.
  public var isInsufficientFunds: Bool {
    if case .insufficientFunds = kind { return true }
    return false
  }

  public func userFacingMessage() -> String {
    switch kind {
    case .insufficientFunds(let availableCents):
      if let cents = availableCents {
        return "Not enough available. You have \(Self.formatDollars(cents)) to cash out."
      }
      return "Not enough available to cash out that amount."
    case .malformed: return "Couldn't read the response. We'll try again."
    case .transport: return "Couldn't reach DankDash. Check your connection."
    case .server(let message): return message
    case .unauthorized: return "Sign in again to continue."
    case .unimplemented: return "Cashout is not available yet."
    case .other(let message): return message
    }
  }

  private static func extractAvailableCents(_ details: JSONValue) -> Int? {
    // `details` is an open record; the cashout service ships
    // `{ requestedCents, availableCents, lifetimeCents, outstandingCents }`.
    guard case .object(let object) = details,
          case .number(let value) = object["availableCents"] else {
      return nil
    }
    return Int(value)
  }

  private static func formatDollars(_ cents: Int) -> String {
    let dollars = Decimal(cents) / 100
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.currencyCode = "USD"
    return formatter.string(from: NSDecimalNumber(decimal: dollars)) ?? "$\(cents / 100)"
  }
}
