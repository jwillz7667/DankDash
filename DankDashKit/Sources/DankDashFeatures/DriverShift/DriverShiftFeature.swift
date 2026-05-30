import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork
import DankDashStorage

/// Driver shift home — owns the online/offline toggle, the active
/// shift lifecycle, the map's current-location pin, the demand heatmap,
/// and today's earnings summary.
///
/// State machine in one line: `offline → (auth granted) → online →
/// (location samples + heatmap ticks + heartbeats) → (toggle) → offline`.
///
/// The reducer is the system of record for online/offline state; it
/// writes to ``DriverSessionStore`` on every transition so a
/// force-quit-and-relaunch can resume the active shift without a
/// round-trip to the server.
@Reducer
public struct DriverShiftFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable {
    public var driver: Driver?
    public var activeShift: DriverShift?
    public var earningsToday: DriverEarnings?
    public var heatmap: [DemandHeatmapCell]
    public var currentCoordinate: Coordinate?
    public var locationAuth: LocationAuthorizationStatus
    public var batterySnapshot: BatterySnapshot
    public var locationMode: LocationUpdateMode
    public var isPerformingShiftTransition: Bool
    public var isShowingLocationRationale: Bool
    public var isShowingStatusMenu: Bool
    public var isLoadingDriver: Bool
    public var isLoadingEarnings: Bool
    public var errorBanner: String?

    public init(
      driver: Driver? = nil,
      activeShift: DriverShift? = nil,
      earningsToday: DriverEarnings? = nil,
      heatmap: [DemandHeatmapCell] = [],
      currentCoordinate: Coordinate? = nil,
      locationAuth: LocationAuthorizationStatus = .notDetermined,
      batterySnapshot: BatterySnapshot = BatterySnapshot(level: nil, state: .unknown, isLowPowerModeEnabled: false),
      locationMode: LocationUpdateMode = .standard(accuracy: .balanced),
      isPerformingShiftTransition: Bool = false,
      isShowingLocationRationale: Bool = false,
      isShowingStatusMenu: Bool = false,
      isLoadingDriver: Bool = false,
      isLoadingEarnings: Bool = false,
      errorBanner: String? = nil
    ) {
      self.driver = driver
      self.activeShift = activeShift
      self.earningsToday = earningsToday
      self.heatmap = heatmap
      self.currentCoordinate = currentCoordinate
      self.locationAuth = locationAuth
      self.batterySnapshot = batterySnapshot
      self.locationMode = locationMode
      self.isPerformingShiftTransition = isPerformingShiftTransition
      self.isShowingLocationRationale = isShowingLocationRationale
      self.isShowingStatusMenu = isShowingStatusMenu
      self.isLoadingDriver = isLoadingDriver
      self.isLoadingEarnings = isLoadingEarnings
      self.errorBanner = errorBanner
    }

    /// Convenience — the reducer treats "any shift not yet ended" as
    /// online, regardless of which substatus (online / enRoutePickup /
    /// enRouteDropoff / onBreak) the driver currently carries.
    public var isOnline: Bool {
      activeShift != nil && (driver?.currentStatus.isOnShift ?? false)
    }

    public var isShiftToggleInteractive: Bool {
      !isPerformingShiftTransition && (driver?.isOnActiveDelivery ?? false) == false
    }
  }

  public enum Action: Equatable, Sendable {
    case onAppear

    // Bootstrap
    case sessionSnapshotLoaded(DriverSessionStore.Snapshot?)
    case driverLoaded(Result<Driver, ShiftErrorBox>)
    case earningsLoaded(Result<DriverEarnings, ShiftErrorBox>)
    case authorizationProbeCompleted(LocationAuthorizationStatus)

    // Toggle online/offline
    case toggleOnlineTapped
    case locationRationaleAllowTapped
    case locationRationaleDismissed
    case authorizationRequestCompleted(LocationAuthorizationStatus)
    case shiftStarted(Result<DriverShift, ShiftErrorBox>)
    case shiftEnded(Result<DriverShift, ShiftErrorBox>)

    // Live updates while online
    case locationReceived(Coordinate)
    case locationStreamFinished
    case batterySnapshotChanged(BatterySnapshot)
    case heatmapTick
    case heatmapLoaded(Result<[DemandHeatmapCell], ShiftErrorBox>)
    case heartbeatTick

    // Status menu
    case statusMenuTapped
    case statusMenuDismissed
    case statusOptionTapped(SelfSettableDriverStatus)
    case statusUpdated(Result<Driver, ShiftErrorBox>)

    // Misc UI
    case errorBannerDismissed
    case earningsCardTapped

    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Equatable, Sendable {
      case openEarningsDetail
    }
  }

  public enum CancelID: Hashable, Sendable {
    case locationStream
    case heatmapTimer
    case heartbeatTimer
    case batteryEvents
  }

  @Dependency(\.backgroundLocationClient) var locationClient
  @Dependency(\.batteryMonitorClient) var batteryClient
  @Dependency(\.driverShiftAPIClient) var shiftAPI
  @Dependency(\.driverAppAPIClient) var driverAppAPI
  @Dependency(\.driverHeatmapAPIClient) var heatmapAPI
  @Dependency(\.driverSessionStoreClient) var sessionStore
  @Dependency(\.continuousClock) var clock
  @Dependency(\.date.now) var now

  /// Fixed cadences from the Phase 19 plan. Heatmap refreshes every
  /// 60s when online, heartbeat pings the server every 90s so dispatch
  /// can age-out drivers that stopped reporting.
  public static let heatmapRefreshInterval: Duration = .seconds(60)
  public static let heartbeatInterval: Duration = .seconds(90)

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .onAppear:
        state.isLoadingDriver = true
        state.isLoadingEarnings = true
        return .merge(
          loadDriver(),
          loadTodayEarnings(),
          probeAuthorization(),
          loadSessionSnapshot(),
          observeBattery()
        )

      case .sessionSnapshotLoaded(let snapshot):
        guard let snapshot else { return .none }
        // Cold start with an active shift on disk — render online
        // optimistically; the subsequent `driverLoaded` reconciles
        // the authoritative status.
        state.activeShift = DriverShift(
          id: snapshot.shiftId,
          driverId: state.driver?.id ?? UUID(),
          startedAt: snapshot.startedAt,
          endedAt: nil,
          startingLocation: snapshot.lastKnownLocationLat.flatMap { lat in
            snapshot.lastKnownLocationLng.map { lng in
              Coordinate(latitude: lat, longitude: lng)
            }
          },
          endingLocation: nil,
          totalMiles: nil,
          totalDeliveries: 0,
          totalEarningsCents: 0
        )
        if let lat = snapshot.lastKnownLocationLat,
           let lng = snapshot.lastKnownLocationLng {
          state.currentCoordinate = Coordinate(latitude: lat, longitude: lng)
        }
        return .none

      case .driverLoaded(.success(let driver)):
        state.isLoadingDriver = false
        state.driver = driver
        // Honor the server's authoritative status on resume — if the
        // server says the driver is online we keep listening for
        // location samples + the heartbeat/heatmap timers; if the
        // session-store snapshot resurrected an activeShift but the
        // server reports offline, tear the optimistic state down.
        if driver.currentStatus.isOnShift && state.activeShift != nil {
          return startSideEffects(currentCoordinate: state.currentCoordinate)
        }
        if !driver.currentStatus.isOnShift {
          state.activeShift = nil
        }
        return .none

      case .driverLoaded(.failure(let box)):
        state.isLoadingDriver = false
        // The Phase 19 backend doesn't yet expose `GET /v1/driver/me`;
        // a 404 means the driver record isn't set up — the parent
        // root reducer reads `driverAppAPIClient` directly to drive
        // the onboarding-vs-shift route, so here we just surface a
        // gentle banner and let the user pull-to-refresh.
        if box.endpointNotYetAvailable {
          state.errorBanner = nil
        } else {
          state.errorBanner = box.userFacingMessage()
        }
        return .none

      case .earningsLoaded(.success(let earnings)):
        state.isLoadingEarnings = false
        state.earningsToday = earnings
        return .none

      case .earningsLoaded(.failure(let box)):
        state.isLoadingEarnings = false
        // Earnings is read-only and non-blocking; suppress the
        // endpoint-not-yet-available case the same way the heatmap
        // does.
        if !box.endpointNotYetAvailable {
          state.errorBanner = box.userFacingMessage()
        }
        return .none

      case .authorizationProbeCompleted(let status):
        state.locationAuth = status
        return .none

      case .toggleOnlineTapped:
        guard state.isShiftToggleInteractive else { return .none }
        if state.isOnline {
          // Toggling offline — confirm transition then call endShift.
          state.isPerformingShiftTransition = true
          state.errorBanner = nil
          let coord = state.currentCoordinate ?? .init(latitude: 0, longitude: 0)
          return .merge(
            .cancel(id: CancelID.locationStream),
            .cancel(id: CancelID.heatmapTimer),
            .cancel(id: CancelID.heartbeatTimer),
            .run { [shiftAPI, locationClient, sessionStore] send in
              await locationClient.endUpdates()
              do {
                let shift = try await shiftAPI.endShift(coord)
                await sessionStore.clear()
                await send(.shiftEnded(.success(shift)))
              } catch {
                await send(.shiftEnded(.failure(ShiftErrorBox(error))))
              }
            }
          )
        }
        // Toggling online — gate on authorization. If not authorized,
        // surface the rationale sheet first; the user accepts there,
        // which dispatches `locationRationaleAllowTapped`.
        switch state.locationAuth {
        case .denied, .restricted:
          state.errorBanner = "Enable Always location in Settings to go online."
          return .none
        case .notDetermined, .authorized, .authorizedWhenInUse:
          state.isShowingLocationRationale = true
          return .none
        case .authorizedAlways:
          return performShiftStart(state: &state)
        }

      case .locationRationaleAllowTapped:
        state.isShowingLocationRationale = false
        return .run { [locationClient] send in
          let status = await locationClient.requestAlwaysAuthorization()
          await send(.authorizationRequestCompleted(status))
        }

      case .locationRationaleDismissed:
        state.isShowingLocationRationale = false
        return .none

      case .authorizationRequestCompleted(let status):
        state.locationAuth = status
        switch status {
        case .authorizedAlways:
          return performShiftStart(state: &state)
        case .denied, .restricted:
          state.errorBanner = "Always location is required to go online."
          return .none
        case .authorizedWhenInUse:
          state.errorBanner = "While Using is not enough — choose Always in Settings to go online."
          return .none
        case .notDetermined, .authorized:
          return .none
        }

      case .shiftStarted(.success(let shift)):
        state.isPerformingShiftTransition = false
        state.activeShift = shift
        state.driver = state.driver.map { driver in
          Driver(
            id: driver.id,
            userId: driver.userId,
            vehicle: driver.vehicle,
            insuranceDocKey: driver.insuranceDocKey,
            insuranceExpiresAt: driver.insuranceExpiresAt,
            backgroundCheckPassedAt: driver.backgroundCheckPassedAt,
            backgroundCheckProviderRef: driver.backgroundCheckProviderRef,
            currentStatus: .online,
            lastStatusChangeAt: now,
            currentLocation: driver.currentLocation,
            currentLocationUpdatedAt: driver.currentLocationUpdatedAt,
            currentOrderId: driver.currentOrderId,
            ratingAvg: driver.ratingAvg,
            ratingCount: driver.ratingCount,
            totalDeliveries: driver.totalDeliveries,
            createdAt: driver.createdAt,
            updatedAt: driver.updatedAt
          )
        }
        return .merge(
          persistShiftSnapshot(shift: shift, coordinate: state.currentCoordinate),
          startSideEffects(currentCoordinate: state.currentCoordinate)
        )

      case .shiftStarted(.failure(let box)):
        state.isPerformingShiftTransition = false
        state.errorBanner = box.userFacingMessage()
        return .cancel(id: CancelID.locationStream)

      case .shiftEnded(.success(let shift)):
        state.isPerformingShiftTransition = false
        state.activeShift = nil
        state.heatmap = []
        state.locationMode = .standard(accuracy: .balanced)
        // Carry the closed-out shift onto the earnings card so the
        // "today" total reflects the just-completed run without a
        // round-trip — the next earnings refresh will reconcile.
        if let earnings = state.earningsToday {
          state.earningsToday = DriverEarnings(
            period: earnings.period,
            since: earnings.since,
            until: earnings.until,
            tipsCents: earnings.tipsCents,
            deliveryFeesCents: earnings.deliveryFeesCents,
            deliveriesCount: earnings.deliveriesCount + shift.totalDeliveries,
            totalCents: earnings.totalCents + shift.totalEarningsCents
          )
        }
        state.driver = state.driver.map { driver in
          Driver(
            id: driver.id,
            userId: driver.userId,
            vehicle: driver.vehicle,
            insuranceDocKey: driver.insuranceDocKey,
            insuranceExpiresAt: driver.insuranceExpiresAt,
            backgroundCheckPassedAt: driver.backgroundCheckPassedAt,
            backgroundCheckProviderRef: driver.backgroundCheckProviderRef,
            currentStatus: .offline,
            lastStatusChangeAt: now,
            currentLocation: driver.currentLocation,
            currentLocationUpdatedAt: driver.currentLocationUpdatedAt,
            currentOrderId: driver.currentOrderId,
            ratingAvg: driver.ratingAvg,
            ratingCount: driver.ratingCount,
            totalDeliveries: driver.totalDeliveries,
            createdAt: driver.createdAt,
            updatedAt: driver.updatedAt
          )
        }
        return .none

      case .shiftEnded(.failure(let box)):
        state.isPerformingShiftTransition = false
        state.errorBanner = box.userFacingMessage()
        // Restart side effects — the shift's still alive on the server
        // until we successfully end it; keep tracking + reporting.
        return startSideEffects(currentCoordinate: state.currentCoordinate)

      case .locationReceived(let coord):
        state.currentCoordinate = coord
        return .run { [sessionStore, now] _ in
          await sessionStore.updateHeartbeat(coord.latitude, coord.longitude, now)
        }

      case .locationStreamFinished:
        // The CoreLocation stream finishes only when we tear it down
        // explicitly — surface as a no-op.
        return .none

      case .batterySnapshotChanged(let snapshot):
        state.batterySnapshot = snapshot
        let nextMode: LocationUpdateMode = snapshot.shouldThrottleForBattery
          ? .significantChange
          : .standard(accuracy: .balanced)
        guard nextMode != state.locationMode, state.isOnline else {
          state.locationMode = nextMode
          return .none
        }
        state.locationMode = nextMode
        return .run { [locationClient, nextMode] _ in
          await locationClient.setUpdateMode(nextMode)
        }

      case .heatmapTick:
        guard let coord = state.currentCoordinate else { return .none }
        return .run { [heatmapAPI] send in
          do {
            let cells = try await heatmapAPI.getHeatmap(near: coord)
            await send(.heatmapLoaded(.success(cells)))
          } catch {
            await send(.heatmapLoaded(.failure(ShiftErrorBox(error))))
          }
        }

      case .heatmapLoaded(.success(let cells)):
        state.heatmap = cells
        return .none

      case .heatmapLoaded(.failure(let box)):
        // Heatmap is a read-side overlay — endpoint-not-yet-available
        // and other failures both fall through silently; the next tick
        // tries again.
        if !box.endpointNotYetAvailable {
          state.heatmap = []
        }
        return .none

      case .heartbeatTick:
        guard let coord = state.currentCoordinate, state.isOnline else { return .none }
        // Heartbeat updates the session-store snapshot and re-asserts
        // the current status to the server so dispatch doesn't age
        // the driver out. We choose .online because heartbeat fires
        // outside any explicit status change — if the driver flipped
        // to on-break, that path's own action sent the status.
        let status: SelfSettableDriverStatus = .online
        return .run { [shiftAPI, sessionStore, now] _ in
          await sessionStore.updateHeartbeat(coord.latitude, coord.longitude, now)
          _ = try? await shiftAPI.updateStatus(status)
        }

      case .statusMenuTapped:
        state.isShowingStatusMenu = true
        return .none

      case .statusMenuDismissed:
        state.isShowingStatusMenu = false
        return .none

      case .statusOptionTapped(let status):
        state.isShowingStatusMenu = false
        return .run { [shiftAPI] send in
          do {
            let driver = try await shiftAPI.updateStatus(status)
            await send(.statusUpdated(.success(driver)))
          } catch {
            await send(.statusUpdated(.failure(ShiftErrorBox(error))))
          }
        }

      case .statusUpdated(.success(let driver)):
        state.driver = driver
        return .none

      case .statusUpdated(.failure(let box)):
        state.errorBanner = box.userFacingMessage()
        return .none

      case .errorBannerDismissed:
        state.errorBanner = nil
        return .none

      case .earningsCardTapped:
        return .send(.delegate(.openEarningsDetail))

      case .delegate:
        return .none
      }
    }
  }

  // MARK: - Effect factories

  private func loadDriver() -> Effect<Action> {
    .run { [driverAppAPI] send in
      do {
        let driver = try await driverAppAPI.getMe()
        await send(.driverLoaded(.success(driver)))
      } catch {
        await send(.driverLoaded(.failure(ShiftErrorBox(error))))
      }
    }
  }

  private func loadTodayEarnings() -> Effect<Action> {
    .run { [driverAppAPI] send in
      do {
        let earnings = try await driverAppAPI.getEarnings(.today)
        await send(.earningsLoaded(.success(earnings)))
      } catch {
        await send(.earningsLoaded(.failure(ShiftErrorBox(error))))
      }
    }
  }

  private func probeAuthorization() -> Effect<Action> {
    .run { [locationClient] send in
      let status = locationClient.authorizationStatus()
      await send(.authorizationProbeCompleted(status))
    }
  }

  private func loadSessionSnapshot() -> Effect<Action> {
    .run { [sessionStore] send in
      let snapshot = await sessionStore.read()
      await send(.sessionSnapshotLoaded(snapshot))
    }
  }

  private func observeBattery() -> Effect<Action> {
    .merge(
      .run { [batteryClient] send in
        let snapshot = batteryClient.snapshot()
        await send(.batterySnapshotChanged(snapshot))
      },
      .run { [batteryClient] send in
        for await snapshot in batteryClient.events() {
          await send(.batterySnapshotChanged(snapshot))
        }
      }
      .cancellable(id: CancelID.batteryEvents, cancelInFlight: true)
    )
  }

  private func performShiftStart(state: inout State) -> Effect<Action> {
    state.isPerformingShiftTransition = true
    state.errorBanner = nil
    let coord = state.currentCoordinate ?? .init(latitude: 0, longitude: 0)
    return .run { [shiftAPI, locationClient] send in
      // Begin updates eagerly so the first sample lands before the
      // server round-trip — the marker appears under the user as the
      // shift transition spinner is still up.
      await locationClient.beginUpdates(.standard(accuracy: .balanced))
      do {
        let shift = try await shiftAPI.startShift(coord)
        await send(.shiftStarted(.success(shift)))
      } catch {
        await send(.shiftStarted(.failure(ShiftErrorBox(error))))
      }
    }
  }

  private func persistShiftSnapshot(shift: DriverShift, coordinate: Coordinate?) -> Effect<Action> {
    let snapshot = DriverSessionStore.Snapshot(
      shiftId: shift.id,
      startedAt: shift.startedAt,
      lastKnownLocationLat: coordinate?.latitude,
      lastKnownLocationLng: coordinate?.longitude,
      lastHeartbeatAt: now
    )
    return .run { [sessionStore] _ in
      await sessionStore.write(snapshot)
    }
  }

  private func startSideEffects(currentCoordinate: Coordinate?) -> Effect<Action> {
    .merge(
      observeLocationStream(),
      startHeatmapTimer(seededCoordinate: currentCoordinate),
      startHeartbeatTimer()
    )
  }

  private func observeLocationStream() -> Effect<Action> {
    .run { [locationClient] send in
      for await coord in locationClient.locationUpdates() {
        await send(.locationReceived(coord))
      }
      await send(.locationStreamFinished)
    }
    .cancellable(id: CancelID.locationStream, cancelInFlight: true)
  }

  private func startHeatmapTimer(seededCoordinate: Coordinate?) -> Effect<Action> {
    let timer: Effect<Action> = .run { [clock] send in
      for await _ in clock.timer(interval: Self.heatmapRefreshInterval) {
        await send(.heatmapTick)
      }
    }
    .cancellable(id: CancelID.heatmapTimer, cancelInFlight: true)
    guard seededCoordinate != nil else { return timer }
    return .merge(.send(.heatmapTick), timer)
  }

  private func startHeartbeatTimer() -> Effect<Action> {
    .run { [clock] send in
      for await _ in clock.timer(interval: Self.heartbeatInterval) {
        await send(.heartbeatTick)
      }
    }
    .cancellable(id: CancelID.heartbeatTimer, cancelInFlight: true)
  }
}

// MARK: - DriverStatus helpers

private extension DriverStatus {
  /// True for any case where the driver is "on shift" from the
  /// reducer's perspective — used to drive the toggle's online state.
  var isOnShift: Bool {
    switch self {
    case .online, .enRoutePickup, .enRouteDropoff, .onBreak: true
    case .offline, .unavailable: false
    }
  }
}

// MARK: - Error box

/// Equatable wrapper around the driver-shift error surface so
/// `TestStore` can pattern-match without depending on the underlying
/// `APIError` / `DriverAPIError` cases directly.
public struct ShiftErrorBox: Error, Equatable, Sendable {
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
