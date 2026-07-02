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
    /// Slide-up dispatch-offer card. Non-nil while an offer sheet is
    /// active; the scoped reducer drives the 30-second countdown and
    /// the accept/decline POSTs. Set by the offer subscription and
    /// cleared by every terminal delegate.
    ///
    /// This is the LEGACY single-best-driver targeting path, kept for
    /// when `DISPATCH_OPEN_POOL_ENABLED` is off server-side. When the
    /// open pool is on (the default) no targeted offers arrive, so this
    /// stays nil and the claimable board below drives the UX instead.
    public var presentedOffer: DispatchOfferFeature.State?

    /// Open delivery pool — claimable orders within range, polled on the
    /// shift cadence and rendered as map pins with a floating tip. The
    /// first driver to claim one wins; everyone else's pin disappears on
    /// the next poll (or the 409 they get if they tap a stale pin).
    public var availableDeliveries: [AvailableDelivery]
    /// The delivery whose detail sheet is open (tapped a pin). nil = no
    /// sheet. Drives the Accept-only popup with the dispensary → drop-off
    /// route preview.
    public var selectedDelivery: AvailableDelivery?
    /// Road-following pickup → drop-off polyline for the open detail
    /// sheet. nil while it resolves (or if directions failed — the sheet
    /// falls back to a straight leg).
    public var selectedDeliveryRoute: [Coordinate]?
    public var isClaimingDelivery: Bool
    /// In-sheet error (a recoverable claim failure that isn't "someone
    /// else got it" — that case dismisses the sheet and banners instead).
    public var deliveryDetailError: String?

    /// Throttle bookkeeping for online-idle location publishing to the
    /// `/driver` socket. `lastPublishedIdleLocation` / `lastIdlePublishAt`
    /// record the coordinate + time of the most recent idle publish so the
    /// reducer can gate the next one on the 30s-or-150m rule. Reset when a
    /// shift ends so the first fix of the next shift publishes immediately.
    /// Not surfaced in the public initializer — internal cadence state.
    public var lastPublishedIdleLocation: Coordinate? = nil
    public var lastIdlePublishAt: Date? = nil

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
      errorBanner: String? = nil,
      presentedOffer: DispatchOfferFeature.State? = nil,
      availableDeliveries: [AvailableDelivery] = [],
      selectedDelivery: AvailableDelivery? = nil,
      selectedDeliveryRoute: [Coordinate]? = nil,
      isClaimingDelivery: Bool = false,
      deliveryDetailError: String? = nil
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
      self.presentedOffer = presentedOffer
      self.availableDeliveries = availableDeliveries
      self.selectedDelivery = selectedDelivery
      self.selectedDeliveryRoute = selectedDeliveryRoute
      self.isClaimingDelivery = isClaimingDelivery
      self.deliveryDetailError = deliveryDetailError
    }

    /// Convenience — the reducer treats "any shift not yet ended" as
    /// online, regardless of which substatus (online / enRoutePickup /
    /// enRouteDropoff / onBreak / unavailable) the driver currently
    /// carries. Drives the master toggle (GO ONLINE vs GO OFFLINE), the
    /// status pill's reachability, and location tracking.
    public var isOnline: Bool {
      activeShift != nil && (driver?.currentStatus.isOnShift ?? false)
    }

    /// The driver is actively taking new work — `online` specifically.
    /// The soft-pause substatuses (`onBreak` / `unavailable`) are
    /// on-shift but must NOT pull the open-pool board or receive
    /// targeted offers; `enRoute*` is already committed to a delivery.
    /// Distinct from ``isOnline`` ("the shift is running").
    public var isAcceptingWork: Bool {
      isOnline && driver?.currentStatus == .online
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
    case returnToDeliveryTapped

    // Dispatch offer subscription
    case offerReceived(DispatchOffer)
    case offerStreamFinished
    case presentedOffer(DispatchOfferFeature.Action)
    case offerSheetDismissed

    // Realtime `/driver` dispatch-board events (offer:new / offer:expired /
    // delivery:claimed) — the push complement to the offer + deliveries polls.
    case dispatchEventReceived(DriverDispatchEvent)

    // Open delivery pool
    case deliveriesTick
    case availableDeliveriesLoaded(Result<[AvailableDelivery], ShiftErrorBox>)
    case deliveryPinTapped(AvailableDelivery)
    case deliveryRouteLoaded([Coordinate]?)
    case claimDeliveryTapped
    case claimDeliveryResponse(Result<UUID, ClaimErrorBox>)
    case deliveryDetailDismissed

    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Equatable, Sendable {
      case openEarningsDetail
      /// Driver accepted a dispatch offer — the parent reducer
      /// (``DriverRootFeature``) routes to ``ActiveRouteFeature`` for
      /// this order id.
      case acceptedOffer(orderId: UUID)
      /// Driver is mid-delivery (server still carries
      /// `current_order_id`) but is looking at the shift home — e.g.
      /// they backed out of the route screen. The parent re-mounts
      /// ``ActiveRouteFeature`` for the order in flight.
      case resumeActiveDelivery(orderId: UUID)
    }
  }

  public enum CancelID: Hashable, Sendable {
    case locationStream
    case heatmapTimer
    case heartbeatTimer
    case batteryEvents
    case offerStream
    case deliveriesTimer
    case deliveryRoute
    case claim
    case dispatchEvents
    case offerFetch
  }

  @Dependency(\.backgroundLocationClient) var locationClient
  @Dependency(\.batteryMonitorClient) var batteryClient
  @Dependency(\.driverRealtimeClient) var driverRealtime
  @Dependency(\.driverShiftAPIClient) var shiftAPI
  @Dependency(\.driverAppAPIClient) var driverAppAPI
  @Dependency(\.driverHeatmapAPIClient) var heatmapAPI
  @Dependency(\.driverSessionStoreClient) var sessionStore
  @Dependency(\.offerSubscriptionClient) var offerSubscription
  @Dependency(\.deliveriesAPIClient) var deliveriesAPI
  @Dependency(\.directionsClient) var directionsClient
  @Dependency(\.continuousClock) var clock
  @Dependency(\.date.now) var now

  /// Fixed cadences from the Phase 19 plan. Heatmap refreshes every
  /// 60s when online, heartbeat pings the server every 90s so dispatch
  /// can age-out drivers that stopped reporting.
  public static let heatmapRefreshInterval: Duration = .seconds(60)
  public static let heartbeatInterval: Duration = .seconds(90)
  /// Open-pool board refresh. Tighter than the heatmap so a claimed
  /// pin clears (and a fresh ready order appears) within a few seconds —
  /// the 409-on-claim is the correctness backstop, this just keeps the
  /// map feeling live.
  public static let deliveriesRefreshInterval: Duration = .seconds(15)

  /// Online-idle location publishing to the `/driver` socket. Far coarser
  /// than the ≤1Hz active-delivery cadence `ActiveRouteFeature` uses: an
  /// idle driver only needs dispatch to know their neighborhood, so we
  /// publish at most every 30 seconds OR whenever they move ≥150 meters —
  /// whichever comes first. This keeps `drivers.current_location` fresh for
  /// open-pool radius + offer scoring without draining the battery or
  /// flooding the ingest stream. Under Low Power Mode the location stream
  /// itself switches to `.significantChange` (fixes hundreds of meters
  /// apart), so cadence naturally drops out further without any extra
  /// branch here — sparse fixes simply clear the distance gate every time.
  public static let idleLocationPublishInterval: TimeInterval = 30
  public static let idleLocationPublishDistanceMeters: Double = 150

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
          state.presentedOffer = nil
          state.availableDeliveries = []
          state.selectedDelivery = nil
          state.selectedDeliveryRoute = nil
          let coord = state.currentCoordinate ?? .init(latitude: 0, longitude: 0)
          return .merge(
            .cancel(id: CancelID.locationStream),
            .cancel(id: CancelID.heatmapTimer),
            .cancel(id: CancelID.heartbeatTimer),
            .cancel(id: CancelID.offerStream),
            .cancel(id: CancelID.dispatchEvents),
            .cancel(id: CancelID.offerFetch),
            .cancel(id: CancelID.deliveriesTimer),
            .cancel(id: CancelID.deliveryRoute),
            .run { [shiftAPI, locationClient, driverRealtime, sessionStore] send in
              await locationClient.endUpdates()
              // Tear down the `/driver` socket opened by idle publishing so
              // no location leaves the device once the shift is over.
              await driverRealtime.disconnect()
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
        // Toggling online — gate on authorization. A brand-new driver is
        // `.notDetermined`, so surface the rationale sheet first; the user
        // accepts there, which dispatches `locationRationaleAllowTapped`.
        // Any authorized grant — including While-Using — is enough to start:
        // iOS never grants Always on the first prompt, so requiring it here
        // would strand every new driver (see `authorizationRequestCompleted`).
        switch state.locationAuth {
        case .denied, .restricted:
          state.errorBanner = "Location access is required to go online. Enable it in Settings."
          return .none
        case .notDetermined:
          state.isShowingLocationRationale = true
          return .none
        case .authorized, .authorizedWhenInUse, .authorizedAlways:
          return performShiftStart(state: &state)
        }

      case .locationRationaleAllowTapped:
        // Keep the rationale sheet presented while CoreLocation shows its
        // system prompt. Dismissing it in this same tick races the alert
        // presentation — the prompt can silently fail to appear, which
        // reads to the driver as "Allow does nothing." We dismiss when the
        // result lands, in `authorizationRequestCompleted`.
        return .run { [locationClient] send in
          let status = await locationClient.requestAlwaysAuthorization()
          await send(.authorizationRequestCompleted(status))
        }

      case .locationRationaleDismissed:
        state.isShowingLocationRationale = false
        return .none

      case .authorizationRequestCompleted(let status):
        state.isShowingLocationRationale = false
        state.locationAuth = status
        switch status {
        case .authorized, .authorizedWhenInUse, .authorizedAlways:
          // While-Using is enough to start: foreground tracking works now,
          // and `allowsBackgroundLocationUpdates` gives provisional
          // background coverage, with iOS prompting to upgrade to Always
          // after the first background session. iOS never offers Always on
          // the first prompt, so accepting only Always here would mean a
          // new driver can never go online from the in-app flow.
          return performShiftStart(state: &state)
        case .denied, .restricted:
          state.errorBanner = "Location access is required to go online. Enable it in Settings."
          return .none
        case .notDetermined:
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
        state.presentedOffer = nil
        state.availableDeliveries = []
        state.selectedDelivery = nil
        state.selectedDeliveryRoute = nil
        // Clear idle-publish throttle so the next shift's first fix is sent
        // immediately rather than waiting out the previous shift's window.
        state.lastPublishedIdleLocation = nil
        state.lastIdlePublishAt = nil
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
        let sessionEffect: Effect<Action> = .run { [sessionStore, now] _ in
          await sessionStore.updateHeartbeat(coord.latitude, coord.longitude, now)
        }
        // Publish live position to the `/driver` socket while online and NOT
        // on an active delivery. During a delivery `ActiveRouteFeature` owns
        // the ≤1Hz publish on the same socket, so we stay silent to avoid
        // double-streaming. Heavily throttled (30s OR 150m of movement) so
        // dispatch's open-pool radius + offer scoring see a fresh
        // `drivers.current_location` without burning battery/radio. The
        // socket opens lazily on first emit; the server resolves the (null)
        // active delivery from the JWT and persists the point regardless.
        guard state.isOnline,
              state.driver?.isOnActiveDelivery != true,
              shouldPublishIdleLocation(state: state, coordinate: coord)
        else {
          return sessionEffect
        }
        state.lastIdlePublishAt = now
        state.lastPublishedIdleLocation = coord
        return .merge(
          sessionEffect,
          .run { [driverRealtime] _ in
            await driverRealtime.publishLocation(coord)
          }
        )

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
        // Heartbeat updates the session-store snapshot and re-asserts the
        // driver's CURRENT self-set status so dispatch sees freshness
        // without clobbering a deliberate pause. Forcing `.online` here
        // used to silently un-pause an on-break / unavailable driver on
        // the next 90s tick. `enRoute*` has no self-settable projection,
        // so the status ping is skipped mid-delivery (the location
        // heartbeat still fires).
        let selfSettable = state.driver?.currentStatus.asSelfSettable
        return .run { [shiftAPI, sessionStore, now] _ in
          await sessionStore.updateHeartbeat(coord.latitude, coord.longitude, now)
          if let selfSettable {
            _ = try? await shiftAPI.updateStatus(selfSettable)
          }
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
        // Pausing (on_break / unavailable) clears the claimable board and
        // any open claim sheet — a paused driver can't take work, and a
        // stale pin would only earn a 409 on tap. The board repopulates
        // on the next deliveries tick once they flip back to online.
        if driver.currentStatus != .online {
          state.availableDeliveries = []
          state.selectedDelivery = nil
          state.selectedDeliveryRoute = nil
          state.deliveryDetailError = nil
          return .cancel(id: CancelID.deliveryRoute)
        }
        return .none

      case .statusUpdated(.failure(let box)):
        state.errorBanner = box.userFacingMessage()
        return .none

      case .errorBannerDismissed:
        state.errorBanner = nil
        return .none

      case .earningsCardTapped:
        return .send(.delegate(.openEarningsDetail))

      case .returnToDeliveryTapped:
        // Only meaningful while the driver actually carries an order —
        // the button is hidden otherwise, but a stale tap racing a
        // refresh must not mount a route screen with no order behind it.
        guard let orderId = state.driver?.currentOrderId else { return .none }
        return .send(.delegate(.resumeActiveDelivery(orderId: orderId)))

      case .offerReceived(let offer):
        // Ignore an offer landing for a different driver (shouldn't
        // happen — the endpoint filters by the authenticated driver
        // server-side — but a stale token in the stream queue can race
        // a sign-out), or one we're already presenting. A paused driver
        // (on_break / unavailable) is on shift but not accepting, so
        // gate on `isAcceptingWork`, not just `isOnline`.
        guard state.isAcceptingWork else { return .none }
        if let presented = state.presentedOffer, presented.offer.id == offer.id {
          return .none
        }
        // Refuse to stack offer sheets — if a fresher offer arrives
        // while the driver is still deliberating, the existing one wins
        // until it terminates. The new offer expires server-side on its
        // own clock, so we don't lose it permanently.
        guard state.presentedOffer == nil else { return .none }
        state.presentedOffer = DispatchOfferFeature.State(offer: offer)
        return .none

      case .offerStreamFinished:
        // The subscription naturally ended (driver toggled offline, the
        // dependency closed the stream). Cleanup is handled by the
        // `.toggleOnlineTapped` / `.shiftEnded` paths; nothing to do
        // here except acknowledge the terminal yield.
        return .none

      case .dispatchEventReceived(let event):
        switch event {
        case .offerNew:
          // Don't trust the pushed summary (ids only) — fetch the
          // authoritative pending list and mount via the same path the
          // 10s poll uses. Gate exactly like `.deliveriesTick` /
          // `.offerReceived`: accepting work, free, and not already
          // showing a sheet (refuse-to-stack lives in `.offerReceived`
          // too, but skipping the fetch avoids a pointless round-trip).
          guard state.isAcceptingWork,
                state.driver?.isOnActiveDelivery != true,
                state.presentedOffer == nil else { return .none }
          return .run { [offerSubscription] send in
            guard let offers = try? await offerSubscription.fetchPending() else { return }
            for offer in offers {
              await send(.offerReceived(offer))
            }
          }
          .cancellable(id: CancelID.offerFetch, cancelInFlight: true)

        case .offerExpired(let offerId):
          // Dismiss the sheet if it's the offer that just expired. The
          // child's own countdown would dismiss it within a second anyway;
          // this makes a server-side supersede/timeout snappy.
          if state.presentedOffer?.offer.id == offerId {
            state.presentedOffer = nil
          }
          return .none

        case .deliveryClaimed(let orderId):
          // Someone won the open-pool race (or the order left
          // awaiting_driver for any reason) — drop the pin now instead of
          // waiting for the 15s deliveries tick.
          state.availableDeliveries.removeAll { $0.orderId == orderId }
          if state.selectedDelivery?.orderId == orderId {
            state.selectedDelivery = nil
            state.selectedDeliveryRoute = nil
            state.deliveryDetailError = nil
            return .cancel(id: CancelID.deliveryRoute)
          }
          return .none
        }

      case .presentedOffer(.delegate(.accepted(let offer))):
        state.presentedOffer = nil
        return .send(.delegate(.acceptedOffer(orderId: offer.orderId)))

      case .presentedOffer(.delegate(.declined)),
           .presentedOffer(.delegate(.expired)),
           .presentedOffer(.delegate(.unavailable)):
        state.presentedOffer = nil
        return .none

      case .presentedOffer:
        return .none

      case .offerSheetDismissed:
        // SwiftUI drag-dismiss path — treat as a soft decline so the
        // server-side row still ages out naturally. We don't fire the
        // decline POST because the driver may have wanted to keep the
        // sheet up; the next poll re-yields if the row is still active.
        state.presentedOffer = nil
        return .none

      case .deliveriesTick:
        // Only poll the open pool while accepting work and free — a
        // paused driver (on_break / unavailable) shouldn't see claimable
        // orders, and a driver already on a delivery can't take a second
        // one (the server returns an empty board for both anyway).
        guard state.isAcceptingWork, state.driver?.isOnActiveDelivery != true else { return .none }
        return .run { [deliveriesAPI] send in
          do {
            let deliveries = try await deliveriesAPI.list()
            await send(.availableDeliveriesLoaded(.success(deliveries)))
          } catch {
            await send(.availableDeliveriesLoaded(.failure(ShiftErrorBox(error))))
          }
        }

      case .availableDeliveriesLoaded(.success(let deliveries)):
        state.availableDeliveries = deliveries
        // If the sheet is open for a delivery that just left the board
        // (claimed by someone else, canceled), drop it — the driver
        // can't claim a pin that no longer exists, and leaving the sheet
        // up would only earn them a 409.
        if let selected = state.selectedDelivery,
           !deliveries.contains(where: { $0.orderId == selected.orderId }) {
          state.selectedDelivery = nil
          state.selectedDeliveryRoute = nil
          state.deliveryDetailError = nil
          return .cancel(id: CancelID.deliveryRoute)
        }
        return .none

      case .availableDeliveriesLoaded(.failure):
        // The board is a read-side overlay — a failed refresh keeps the
        // last-known pins (the next tick retries). Endpoint-not-yet-
        // available and transient errors both fall through silently.
        return .none

      case .deliveryPinTapped(let delivery):
        state.selectedDelivery = delivery
        state.selectedDeliveryRoute = nil
        state.deliveryDetailError = nil
        // Best-effort road-following preview from pickup to drop-off. A
        // directions failure is non-fatal — the sheet renders a straight
        // leg instead (LiveMapView's deliveryLeg with two points).
        return .run { [directionsClient] send in
          let coordinates = try? await directionsClient
            .calculateRoute(delivery.pickup, delivery.dropoff, .automobile)
            .polyline
          await send(.deliveryRouteLoaded(coordinates))
        }
        .cancellable(id: CancelID.deliveryRoute, cancelInFlight: true)

      case .deliveryRouteLoaded(let coordinates):
        // Ignore a late route for a sheet the driver already dismissed.
        guard state.selectedDelivery != nil else { return .none }
        state.selectedDeliveryRoute = coordinates
        return .none

      case .claimDeliveryTapped:
        guard let selected = state.selectedDelivery, !state.isClaimingDelivery else { return .none }
        state.isClaimingDelivery = true
        state.deliveryDetailError = nil
        return .run { [deliveriesAPI] send in
          do {
            let orderId = try await deliveriesAPI.claim(selected.orderId)
            await send(.claimDeliveryResponse(.success(orderId)))
          } catch {
            await send(.claimDeliveryResponse(.failure(ClaimErrorBox(error))))
          }
        }
        .cancellable(id: CancelID.claim, cancelInFlight: true)

      case .claimDeliveryResponse(.success(let orderId)):
        state.isClaimingDelivery = false
        state.availableDeliveries.removeAll { $0.orderId == orderId }
        state.selectedDelivery = nil
        state.selectedDeliveryRoute = nil
        state.deliveryDetailError = nil
        // Route into the active-route screen — same delegate the legacy
        // targeted-offer accept fires, so the parent's handling is shared.
        return .send(.delegate(.acceptedOffer(orderId: orderId)))

      case .claimDeliveryResponse(.failure(let box)):
        state.isClaimingDelivery = false
        if box.isAlreadyClaimed {
          // Another driver won the race (or the order left the pool).
          // Dismiss the sheet, drop the pin, and surface a gentle banner
          // — not the in-sheet error, since the sheet is going away.
          if let selected = state.selectedDelivery {
            state.availableDeliveries.removeAll { $0.orderId == selected.orderId }
          }
          state.selectedDelivery = nil
          state.selectedDeliveryRoute = nil
          state.deliveryDetailError = nil
          state.errorBanner = "Another driver grabbed that delivery."
          return .cancel(id: CancelID.deliveryRoute)
        }
        // Recoverable failure (transport, server) — keep the sheet up so
        // the driver can retry.
        state.deliveryDetailError = box.userFacingMessage()
        return .none

      case .deliveryDetailDismissed:
        state.selectedDelivery = nil
        state.selectedDeliveryRoute = nil
        state.deliveryDetailError = nil
        return .cancel(id: CancelID.deliveryRoute)

      case .delegate:
        return .none
      }
    }
    .ifLet(\.presentedOffer, action: \.presentedOffer) {
      DispatchOfferFeature()
    }
  }

  // MARK: - Idle location publish gate

  /// Decide whether an incoming fix warrants an online-idle publish.
  /// Publishes on the first fix of a shift, then only after
  /// ``idleLocationPublishInterval`` has elapsed OR the driver has moved at
  /// least ``idleLocationPublishDistanceMeters`` from the last published
  /// point — whichever comes first.
  private func shouldPublishIdleLocation(state: State, coordinate: Coordinate) -> Bool {
    guard let lastAt = state.lastIdlePublishAt,
          let lastCoord = state.lastPublishedIdleLocation
    else {
      return true
    }
    if now.timeIntervalSince(lastAt) >= Self.idleLocationPublishInterval {
      return true
    }
    return coordinate.distanceMeters(to: lastCoord) >= Self.idleLocationPublishDistanceMeters
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
      startHeartbeatTimer(),
      observeOfferStream(),
      observeDispatchEvents(),
      startDeliveriesTimer()
    )
  }

  private func observeDispatchEvents() -> Effect<Action> {
    .run { [driverRealtime] send in
      for await event in await driverRealtime.dispatchEvents() {
        await send(.dispatchEventReceived(event))
      }
    }
    .cancellable(id: CancelID.dispatchEvents, cancelInFlight: true)
  }

  private func startDeliveriesTimer() -> Effect<Action> {
    .merge(
      .send(.deliveriesTick),
      .run { [clock] send in
        for await _ in clock.timer(interval: Self.deliveriesRefreshInterval) {
          await send(.deliveriesTick)
        }
      }
      .cancellable(id: CancelID.deliveriesTimer, cancelInFlight: true)
    )
  }

  private func observeOfferStream() -> Effect<Action> {
    .run { [offerSubscription] send in
      for await offer in offerSubscription.stream() {
        await send(.offerReceived(offer))
      }
      await send(.offerStreamFinished)
    }
    .cancellable(id: CancelID.offerStream, cancelInFlight: true)
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
  /// True for any case where the driver is "on shift" — i.e. they
  /// started a shift and haven't gone offline. The soft-pause
  /// substatuses (`onBreak` / `unavailable`) ARE on shift: they pause
  /// incoming work without ending the shift, so the master toggle reads
  /// "online" and the status pill stays reachable to flip back. Only
  /// `offline` (no shift) is off.
  ///
  /// Excluding `unavailable` here previously trapped the driver: the
  /// status pill disabled, and the toggle tried to `startShift` on an
  /// already-open shift (server 409).
  var isOnShift: Bool {
    switch self {
    case .online, .enRoutePickup, .enRouteDropoff, .onBreak, .unavailable: true
    case .offline: false
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

// MARK: - Claim error box

/// Equatable wrapper around the open-pool claim error surface, mirroring
/// ``OfferErrorBox``. Classifies the "someone else got it / no longer
/// claimable" cluster (HTTP 409, `DRIVER_DELIVERY_ALREADY_CLAIMED`,
/// `DRIVER_DELIVERY_NOT_AVAILABLE`, `DRIVER_BUSY_WITH_ORDER`) as
/// ``alreadyClaimed`` because the map UX branches on it — the detail
/// sheet dismisses and the pin drops without an angry in-sheet error.
public struct ClaimErrorBox: Error, Equatable, Sendable {
  public enum Kind: Equatable, Sendable {
    case alreadyClaimed
    case transport
    case unauthorized
    case malformed(String)
    case server(message: String, code: String?)
    case other(String)
  }

  public let kind: Kind

  public init(_ error: Error) {
    if let driverError = error as? DriverAPIError {
      switch driverError {
      case .malformedPayload(let label): self.kind = .malformed(label)
      case .unimplemented(let name): self.kind = .other(name)
      }
      return
    }
    if let apiError = error as? APIError {
      switch apiError {
      case .server(let status, let envelope):
        if status == 409
          || envelope.error.code == "DRIVER_DELIVERY_ALREADY_CLAIMED"
          || envelope.error.code == "DRIVER_DELIVERY_NOT_AVAILABLE"
          || envelope.error.code == "DRIVER_BUSY_WITH_ORDER"
        {
          self.kind = .alreadyClaimed
        } else {
          self.kind = .server(message: envelope.error.message, code: envelope.error.code)
        }
      case .transport: self.kind = .transport
      case .unauthorized, .noRefreshToken: self.kind = .unauthorized
      case .unexpectedStatus, .decoding, .configuration:
        self.kind = .other(String(describing: apiError))
      }
      return
    }
    self.kind = .other(String(describing: error))
  }

  public var isAlreadyClaimed: Bool {
    if case .alreadyClaimed = kind { return true }
    return false
  }

  public func userFacingMessage() -> String {
    switch kind {
    case .alreadyClaimed: "Another driver grabbed that delivery."
    case .transport: "Couldn't reach DankDash. Check your connection."
    case .unauthorized: "Sign in again to continue."
    case .malformed: "Couldn't read the response. We'll try again."
    case .server(let message, _): message
    case .other(let message): message
    }
  }
}
