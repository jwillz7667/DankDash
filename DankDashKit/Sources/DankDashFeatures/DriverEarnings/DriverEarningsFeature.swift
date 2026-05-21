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
@Reducer
public struct DriverEarningsFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable {
    public var period: EarningsPeriod
    public var earnings: DriverEarnings?
    public var shifts: [DriverShift]
    public var isLoadingEarnings: Bool
    public var isLoadingShifts: Bool
    public var isRefreshing: Bool
    public var errorBanner: String?

    public init(
      period: EarningsPeriod = .today,
      earnings: DriverEarnings? = nil,
      shifts: [DriverShift] = [],
      isLoadingEarnings: Bool = false,
      isLoadingShifts: Bool = false,
      isRefreshing: Bool = false,
      errorBanner: String? = nil
    ) {
      self.period = period
      self.earnings = earnings
      self.shifts = shifts
      self.isLoadingEarnings = isLoadingEarnings
      self.isLoadingShifts = isLoadingShifts
      self.isRefreshing = isRefreshing
      self.errorBanner = errorBanner
    }

    /// True while the initial fetch is in flight and we have no
    /// content yet — drives the spinner-vs-empty-state branching in
    /// the view.
    public var isInitialLoading: Bool {
      (isLoadingEarnings || isLoadingShifts) && earnings == nil && shifts.isEmpty
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

    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Equatable, Sendable {
      case openShiftDetail(shiftId: UUID)
    }
  }

  @Dependency(\.driverAppAPIClient) var driverAppAPI

  public init() {}

  private enum CancelID: Hashable {
    case earnings
    case shifts
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
