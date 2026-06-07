import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork
import DankDashStorage

/// Live tracking surface for a single in-flight order. Owns the detail
/// fetch, the realtime subscription that drives status / driver / ETA
/// updates, the 15-second polling fallback used when the socket is
/// down, and the 5-minute post-delivery timer that promotes the order
/// to "rating due".
///
/// State flow on the happy path:
///
/// 1. `.onAppear` kicks off three concurrent effects:
///    a. cache read from ``OrderCacheClient`` — populates state instantly
///       on cold start so the timeline renders before the network call
///       returns.
///    b. detail fetch via ``OrdersAPIClient/getOrder(_:)`` — authoritative
///       snapshot, overwrites any cached values.
///    c. realtime subscribe via ``RealtimeClient/subscribe(_:)`` — opens
///       a long-running effect that loops `for try await` over the
///       stream and re-subscribes after errors.
/// 2. As realtime events arrive, the reducer applies them to the right
///    slice of state (status / driver / coordinate / etaMinutes).
/// 3. If the realtime stream errors, the reducer flips
///    ``State/isPolling`` on and starts a 15s `clock.sleep` loop that
///    re-fetches detail until the next realtime event arrives.
/// 4. When ``Order/status`` reaches ``OrderStatus/delivered``, the
///    reducer schedules a 5-minute timer; on fire it sets
///    ``State/ratingDue`` and emits the matching delegate.
/// 5. `.onDisappear` cancels everything via three cancel ids — the next
///    `.onAppear` rebuilds fresh subscriptions.
@Reducer
public struct OrderTrackingFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable {
    public let orderId: UUID

    /// Server-fetched order projection. `nil` until the first network
    /// (or cache) load completes.
    public var order: Order?

    /// Append-only history of `order_events` rows. The realtime stream
    /// pushes synthesized rows on `status_changed` so this stays
    /// in-order without a re-fetch.
    public var events: [OrderEvent]

    /// Driver profile when one is assigned. `nil` before
    /// `awaiting_driver` → `driver_assigned`. The map is only rendered
    /// when this is non-nil (computed by ``mapVisible``).
    public var driver: DriverPublicProfile?

    /// Latest `driver:location` ping. Render rate is throttled on the
    /// view side (1Hz max) — the reducer just stores the freshest value.
    public var driverCoordinate: Coordinate?

    /// Pickup dispensary name — the dispensary map pin's title. Set from
    /// the detail fetch (or cache); `nil` until the first load lands.
    public var dispensaryName: String?

    /// Pickup pin coordinate (the dispensary storefront).
    public var dispensaryCoordinate: Coordinate?

    /// Drop-off pin coordinate (the customer's delivery address, frozen
    /// at checkout). The map is gated on this — ``mapVisible`` stays
    /// false until it's populated by a detail fetch or a (recent) cache
    /// hit.
    public var dropoffCoordinate: Coordinate?

    /// Human label for the drop-off pin (the address line-1).
    public var dropoffLabel: String?

    /// Minutes remaining on the server's ETA estimate. The driver app +
    /// dispatch service computes it; the consumer surface just displays.
    public var etaMinutes: Int?

    public var isLoading: Bool

    /// Recoverable error — displayed as a banner. The polling loop
    /// surfaces the most recent failure here too.
    public var error: String?

    /// True while the 15s polling-fallback loop is running. The view
    /// uses this to render an "Updates may be delayed" banner.
    public var isPolling: Bool

    /// Set when the 5-minute post-delivery rating timer fires. Parent
    /// observes via the matching delegate; tests assert directly.
    public var ratingDue: Bool

    /// Star rating the user has selected in the sheet (0 = none). Lives
    /// in reducer state (not the View) so the submit effect can read it
    /// and tests can drive it deterministically.
    public var rating: Int

    /// Optional free-text review backing the sheet's comment field.
    public var ratingComment: String

    /// True while the rate request is in flight — drives the sheet's
    /// spinner and disables re-submission.
    public var isSubmittingRating: Bool

    /// Set once a rating has been accepted by the server this session.
    /// Suppresses re-prompting via the post-delivery timer on a later
    /// `.onAppear`, so a user who already rated isn't asked again.
    public var ratingSubmitted: Bool

    /// Rating-submit failure message, shown inline in the sheet. Distinct
    /// from ``error`` (the live-tracking banner) because the sheet covers
    /// that banner — a failed submit must report where the user is looking.
    public var ratingError: String?

    public init(
      orderId: UUID,
      order: Order? = nil,
      events: [OrderEvent] = [],
      driver: DriverPublicProfile? = nil,
      driverCoordinate: Coordinate? = nil,
      dispensaryName: String? = nil,
      dispensaryCoordinate: Coordinate? = nil,
      dropoffCoordinate: Coordinate? = nil,
      dropoffLabel: String? = nil,
      etaMinutes: Int? = nil,
      isLoading: Bool = false,
      error: String? = nil,
      isPolling: Bool = false,
      ratingDue: Bool = false,
      rating: Int = 0,
      ratingComment: String = "",
      isSubmittingRating: Bool = false,
      ratingSubmitted: Bool = false,
      ratingError: String? = nil
    ) {
      self.orderId = orderId
      self.order = order
      self.events = events
      self.driver = driver
      self.driverCoordinate = driverCoordinate
      self.dispensaryName = dispensaryName
      self.dispensaryCoordinate = dispensaryCoordinate
      self.dropoffCoordinate = dropoffCoordinate
      self.dropoffLabel = dropoffLabel
      self.etaMinutes = etaMinutes
      self.isLoading = isLoading
      self.error = error
      self.isPolling = isPolling
      self.ratingDue = ratingDue
      self.rating = rating
      self.ratingComment = ratingComment
      self.isSubmittingRating = isSubmittingRating
      self.ratingSubmitted = ratingSubmitted
      self.ratingError = ratingError
    }

    /// True when the sheet has enough to submit: at least one star and no
    /// in-flight request. Mirrors the design component's `canSubmit`.
    public var canSubmitRating: Bool {
      rating > 0 && !isSubmittingRating
    }

    /// True once we know where the order is going (the drop-off
    /// coordinate) and it isn't in a terminal state. The view renders
    /// ``LiveMapView`` on this — the customer pin shows from the first
    /// detail load, the dispensary pin whenever its coordinate is known,
    /// and the driver pin appears once a `driver:location` ping arrives.
    /// Gating on the drop-off (rather than `driver != nil`) means the map
    /// is up before a driver is even assigned, which is the more useful
    /// "here's your delivery" affordance.
    public var mapVisible: Bool {
      guard let order, !order.status.isTerminal else { return false }
      return dropoffCoordinate != nil
    }
  }

  public enum Action: Sendable {
    case onAppear
    case onDisappear

    /// Cache hit from ``OrderCacheClient/readDetail``. Only applied when
    /// the reducer has no fresh data yet, so a late cache callback can't
    /// stomp a network result.
    case cachedDetailLoaded(CachedOrderDetail)

    case detailLoaded(Result<OrderDetail, EquatableError>)

    case realtimeEventReceived(RealtimeOrderEvent)
    case realtimeStreamFailed(EquatableError)

    case ratingTimerFired
    case dismissRatingSheet

    case ratingChanged(Int)
    case ratingCommentChanged(String)
    case submitRatingTapped
    case ratingSubmitted(Result<Order, EquatableError>)

    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Sendable, Equatable {
      case ratingDue(orderId: UUID)
    }
  }

  @Dependency(\.ordersAPIClient) var ordersAPIClient
  @Dependency(\.realtimeClient) var realtimeClient
  @Dependency(\.orderCacheClient) var orderCacheClient
  @Dependency(\.continuousClock) var clock
  @Dependency(\.date.now) var now
  @Dependency(\.uuid) var uuid

  public init() {}

  /// Cancellation ids — keep stable across rebuilds so re-entering the
  /// screen replaces the prior subscription rather than running two.
  private enum CancelID: Hashable {
    case subscription
    case polling
    case ratingTimer
    case ratingSubmit
    case driverRefetch
  }

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .onAppear:
        guard !state.isLoading else { return .none }
        state.isLoading = true
        state.error = nil
        let orderId = state.orderId
        return .merge(
          .run { [orderCacheClient] send in
            if let cached = await orderCacheClient.readDetail(orderId) {
              await send(.cachedDetailLoaded(cached))
            }
          },
          .run { [ordersAPIClient] send in
            do {
              let detail = try await ordersAPIClient.getOrder(orderId)
              await send(.detailLoaded(.success(detail)))
            } catch {
              await send(.detailLoaded(.failure(EquatableError(error))))
            }
          },
          subscribeRealtimeEffect(orderId: orderId)
        )

      case .onDisappear:
        return .merge(
          .cancel(id: CancelID.subscription),
          .cancel(id: CancelID.polling),
          .cancel(id: CancelID.ratingTimer),
          .cancel(id: CancelID.ratingSubmit),
          .cancel(id: CancelID.driverRefetch)
        )

      case .cachedDetailLoaded(let cached):
        // Only apply cached values if no fresh detail has landed yet —
        // a race where the cache returns after the network would
        // otherwise downgrade us to stale state.
        guard state.order == nil else { return .none }
        state.order = cached.order
        state.events = cached.events
        state.driver = cached.driver
        // Coords are optional on the cache (legacy entries predate them);
        // a `nil` drop-off just means the map waits for the network load.
        state.dispensaryName = cached.dispensaryName
        state.dispensaryCoordinate = cached.dispensaryCoordinate
        state.dropoffCoordinate = cached.dropoffCoordinate
        state.dropoffLabel = cached.dropoffLabel
        return .none

      case .detailLoaded(.success(let detail)):
        state.isLoading = false
        state.error = nil
        state.order = detail.order
        state.events = detail.events
        state.driver = detail.driver
        state.dispensaryName = detail.dispensaryName
        state.dispensaryCoordinate = detail.dispensaryCoordinate
        state.dropoffCoordinate = detail.dropoffCoordinate
        state.dropoffLabel = detail.dropoffLabel
        let orderId = state.orderId
        let cacheTimestamp = now
        var effects: [Effect<Action>] = [
          .run { [orderCacheClient] _ in
            await orderCacheClient.writeDetail(
              CachedOrderDetail(
                order: detail.order,
                events: detail.events,
                driver: detail.driver,
                cachedAt: cacheTimestamp,
                dispensaryName: detail.dispensaryName,
                dispensaryCoordinate: detail.dispensaryCoordinate,
                dropoffCoordinate: detail.dropoffCoordinate,
                dropoffLabel: detail.dropoffLabel
              ),
              orderId
            )
          }
        ]
        if let timer = ratingTimerEffectIfNeeded(state: state) {
          effects.append(timer)
        }
        return .merge(effects)

      case .detailLoaded(.failure(let err)):
        state.isLoading = false
        state.error = err.message
        return .none

      case .realtimeEventReceived(let event):
        return applyRealtimeEvent(event, state: &state)

      case .realtimeStreamFailed(let err):
        // Surface the failure for the view banner; start polling so the
        // user keeps seeing fresh data until the subscribe loop's next
        // retry succeeds.
        state.error = err.message
        guard !state.isPolling else { return .none }
        state.isPolling = true
        let orderId = state.orderId
        return .run { [ordersAPIClient, clock] send in
          while !Task.isCancelled {
            try await clock.sleep(for: .seconds(15))
            do {
              let detail = try await ordersAPIClient.getOrder(orderId)
              await send(.detailLoaded(.success(detail)))
            } catch {
              await send(.detailLoaded(.failure(EquatableError(error))))
            }
          }
        }.cancellable(id: CancelID.polling, cancelInFlight: true)

      case .ratingTimerFired:
        state.ratingDue = true
        return .send(.delegate(.ratingDue(orderId: state.orderId)))

      case .dismissRatingSheet:
        state.ratingDue = false
        state.ratingError = nil
        return .merge(
          .cancel(id: CancelID.ratingTimer),
          .cancel(id: CancelID.ratingSubmit)
        )

      case .ratingChanged(let value):
        // Clamp to the server's 1–5 range; 0 means "not yet rated".
        state.rating = min(max(value, 0), 5)
        return .none

      case .ratingCommentChanged(let comment):
        state.ratingComment = comment
        return .none

      case .submitRatingTapped:
        guard state.canSubmitRating, state.order != nil else { return .none }
        state.isSubmittingRating = true
        // Rating failures use their own channel (`ratingError`, shown in
        // the sheet) so they don't collide with the tracking banner's
        // `error`, which sits behind the sheet.
        state.ratingError = nil
        let orderId = state.orderId
        let trimmedReview = state.ratingComment.trimmingCharacters(in: .whitespacesAndNewlines)
        let input = OrderRatingInput(
          rating: state.rating,
          review: trimmedReview.isEmpty ? nil : trimmedReview
        )
        return .run { [ordersAPIClient] send in
          do {
            let order = try await ordersAPIClient.rateOrder(orderId, input)
            await send(.ratingSubmitted(.success(order)))
          } catch {
            await send(.ratingSubmitted(.failure(EquatableError(error))))
          }
        }.cancellable(id: CancelID.ratingSubmit, cancelInFlight: true)

      case .ratingSubmitted(.success(let order)):
        state.isSubmittingRating = false
        state.ratingSubmitted = true
        state.ratingError = nil
        state.order = order
        // Dismiss the sheet and retire the prompt for this session.
        state.ratingDue = false
        return .cancel(id: CancelID.ratingTimer)

      case .ratingSubmitted(.failure(let err)):
        // Keep the sheet open with the failure surfaced inline so the
        // user can retry; the submit button re-enables once
        // `isSubmittingRating` clears.
        state.isSubmittingRating = false
        state.ratingError = err.message
        return .none

      case .delegate:
        return .none
      }
    }
  }

  // MARK: - Effect helpers

  /// Long-running subscription loop. After the stream errors we sleep
  /// briefly and re-subscribe — the SocketIO client takes care of its
  /// own reconnect backoff so this loop just keeps asking until the
  /// effect is cancelled.
  private func subscribeRealtimeEffect(orderId: UUID) -> Effect<Action> {
    .run { [realtimeClient, clock] send in
      while !Task.isCancelled {
        let stream = await realtimeClient.subscribe(orderId)
        do {
          for try await event in stream {
            await send(.realtimeEventReceived(event))
          }
        } catch {
          await send(.realtimeStreamFailed(EquatableError(error)))
          try? await clock.sleep(for: .seconds(5))
        }
      }
    }.cancellable(id: CancelID.subscription, cancelInFlight: true)
  }

  /// Apply one realtime event to the right slice of state. Also cancels
  /// polling on the first event after a stream failure — receiving an
  /// event proves realtime is healthy again.
  private func applyRealtimeEvent(
    _ event: RealtimeOrderEvent,
    state: inout State
  ) -> Effect<Action> {
    guard event.orderId == state.orderId else { return .none }

    var statusDidChange = false
    switch event {
    case .statusChanged(_, let status, let occurredAt):
      guard let current = state.order, current.status != status else { break }
      state.order = current.withStatus(status, at: occurredAt)
      state.events.append(
        OrderEvent(
          id: uuid(),
          orderId: current.id,
          eventType: "status_changed",
          actorUserId: nil,
          actorRole: "system",
          payload: .object(["status": .string(status.rawValue)]),
          occurredAt: occurredAt
        )
      )
      statusDidChange = true

    case .driverAssigned(_, let driver, _):
      state.driver = driver

    case .driverLocation(_, let coordinate, _):
      state.driverCoordinate = coordinate

    case .etaUpdated(_, let mins, _):
      state.etaMinutes = mins
    }

    var effects: [Effect<Action>] = []
    if state.isPolling {
      state.isPolling = false
      effects.append(.cancel(id: CancelID.polling))
    }
    if statusDidChange, let timer = ratingTimerEffectIfNeeded(state: state) {
      effects.append(timer)
    }
    // Self-heal a missing driver: if a `status_changed` event advanced us
    // into a driver-bearing state but we never received the
    // `driver_assigned` profile event (so `state.driver` is still nil),
    // pull the detail once to fill the driver card + map driver pin.
    if statusDidChange,
       state.driver == nil,
       let status = state.order?.status,
       Self.expectsDriver(status) {
      effects.append(driverRefetchEffect(orderId: state.orderId))
    }
    return effects.isEmpty ? .none : .merge(effects)
  }

  /// Statuses at or past driver assignment — once the order reaches one
  /// of these a driver profile should exist on the order. Used to decide
  /// whether a `status_changed` that arrived without a paired
  /// `driver_assigned` event warrants a self-healing re-fetch.
  /// `idScanFailed` is in the set because it's only reachable from
  /// `idScanPending`, where a driver is present at the door.
  private static func expectsDriver(_ status: OrderStatus) -> Bool {
    switch status {
    case .driverAssigned, .enRoutePickup, .pickedUp, .enRouteDropoff,
         .arrivedAtDropoff, .idScanPending, .idScanPassed, .idScanFailed,
         .delivered:
      return true
    case .placed, .paymentFailed, .accepted, .rejected, .prepping,
         .readyForPickup, .awaitingDriver, .returnedToStore, .canceled,
         .disputed:
      return false
    }
  }

  /// One-shot detail re-fetch that self-heals a missing driver profile.
  /// Routes through the same `.detailLoaded(.success)` path as the
  /// initial load, so the driver card + map pins + coords fill in.
  /// `cancelInFlight: true` collapses rapid status bumps into a single
  /// fetch. Best-effort: a failure here leaves the existing UI intact (we
  /// only push on success) so a transient error never raises the tracking
  /// banner over otherwise-fine data — the realtime stream / polling
  /// fallback covers retries.
  private func driverRefetchEffect(orderId: UUID) -> Effect<Action> {
    .run { [ordersAPIClient] send in
      if let detail = try? await ordersAPIClient.getOrder(orderId) {
        await send(.detailLoaded(.success(detail)))
      }
    }.cancellable(id: CancelID.driverRefetch, cancelInFlight: true)
  }

  /// Returns a 5-minute `clock.sleep` effect when the current order is
  /// `delivered` and the rating banner hasn't already been dismissed.
  /// Re-running this on every `delivered` transition is safe — the
  /// `.cancellable(id:, cancelInFlight: true)` guarantees only one
  /// timer at a time.
  private func ratingTimerEffectIfNeeded(state: State) -> Effect<Action>? {
    guard
      state.order?.status == .delivered,
      !state.ratingDue,
      !state.ratingSubmitted
    else { return nil }
    return .run { [clock] send in
      try? await clock.sleep(for: .seconds(300))
      await send(.ratingTimerFired)
    }.cancellable(id: CancelID.ratingTimer, cancelInFlight: true)
  }
}

// MARK: - Order mutation helper

extension Order {
  /// Builds a new ``Order`` with `status` swapped and `statusChangedAt`
  /// stamped. Order is immutable on the wire — the reducer needs a
  /// derived value when a realtime `status_changed` event arrives
  /// before the next detail re-fetch.
  func withStatus(_ status: OrderStatus, at changedAt: Date) -> Order {
    Order(
      id: id,
      shortCode: shortCode,
      userId: userId,
      dispensaryId: dispensaryId,
      deliveryAddressId: deliveryAddressId,
      status: status,
      subtotalCents: subtotalCents,
      cannabisTaxCents: cannabisTaxCents,
      salesTaxCents: salesTaxCents,
      deliveryFeeCents: deliveryFeeCents,
      driverTipCents: driverTipCents,
      discountCents: discountCents,
      totalCents: totalCents,
      items: items,
      placedAt: placedAt,
      statusChangedAt: changedAt,
      createdAt: createdAt,
      updatedAt: updatedAt
    )
  }
}
