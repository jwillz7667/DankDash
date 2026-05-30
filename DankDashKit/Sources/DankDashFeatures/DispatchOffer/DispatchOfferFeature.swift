import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Driver dispatch-offer sheet — owns the 30-second countdown,
/// `Accept` / `Decline` POSTs, and emits a delegate when the offer
/// reaches a terminal state. The reducer is a peer to
/// ``DriverShiftFeature`` (a sibling, not a child) — the shift home
/// presents this via `.sheet(item:)` and consumes the delegate cases
/// to advance into the active route.
///
/// State machine in one line:
///
///   `offered → (accept) → accepted (delegate)`
///   `offered → (decline) → declined (delegate)`
///   `offered → (tick → 0) → expired (delegate)`
///   `offered → (accept → 409) → unavailable (delegate)`
///
/// The 30s clock is canonical on the server (`dispatch_offers.expires_at`);
/// the reducer ticks once per second purely to drive the countdown ring
/// animation. A wall-clock skew of a few seconds is acceptable — the
/// server is the authoritative expiry source, and an accept past
/// `expires_at` returns 409.
@Reducer
public struct DispatchOfferFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable, Identifiable {
    public var offer: DispatchOffer
    public var secondsRemaining: TimeInterval
    public var isSubmitting: Bool
    public var errorBanner: String?

    public var id: UUID { offer.id }

    public init(
      offer: DispatchOffer,
      secondsRemaining: TimeInterval? = nil,
      isSubmitting: Bool = false,
      errorBanner: String? = nil
    ) {
      self.offer = offer
      self.secondsRemaining = secondsRemaining ?? offer.secondsRemaining()
      self.isSubmitting = isSubmitting
      self.errorBanner = errorBanner
    }

    public var canRespond: Bool {
      !isSubmitting && secondsRemaining > 0
    }
  }

  public enum Action: Equatable, Sendable {
    case onAppear
    case tick

    case acceptTapped
    case declineTapped

    case acceptResponse(Result<DispatchOffer, OfferErrorBox>)
    case declineResponse(Result<DispatchOffer, OfferErrorBox>)

    case errorBannerDismissed

    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Equatable, Sendable {
      /// Driver accepted; route the active route screen to this offer.
      case accepted(DispatchOffer)
      /// Driver explicitly declined.
      case declined(offerId: UUID)
      /// Countdown ran out without a response.
      case expired(offerId: UUID)
      /// Server returned 409 — another driver got there first, or the
      /// dispatch row already left the `offered` state.
      case unavailable(offerId: UUID)
    }
  }

  public enum CancelID: Hashable, Sendable {
    case tick
    case accept
    case decline
  }

  @Dependency(\.dispatchOfferAPIClient) var offersAPI
  @Dependency(\.hapticsClient) var haptics
  @Dependency(\.continuousClock) var clock
  @Dependency(\.date.now) var now

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .onAppear:
        // Reseed the countdown against the current wall clock — covers
        // the case where the sheet was constructed seconds before
        // presentation (e.g. the realtime decoder snapshots the offer
        // then waits a beat for the animation to settle).
        state.secondsRemaining = state.offer.secondsRemaining(referenceDate: now)
        if state.secondsRemaining <= 0 {
          return .send(.delegate(.expired(offerId: state.offer.id)))
        }
        return .merge(
          .run { [haptics] _ in await haptics.notify(.warning) },
          .run { [clock] send in
            for await _ in clock.timer(interval: .seconds(1)) {
              await send(.tick)
            }
          }
          .cancellable(id: CancelID.tick, cancelInFlight: true)
        )

      case .tick:
        state.secondsRemaining = state.offer.secondsRemaining(referenceDate: now)
        guard state.secondsRemaining <= 0 else { return .none }
        let id = state.offer.id
        return .merge(
          .cancel(id: CancelID.tick),
          .cancel(id: CancelID.accept),
          .cancel(id: CancelID.decline),
          .send(.delegate(.expired(offerId: id)))
        )

      case .acceptTapped:
        guard state.canRespond else { return .none }
        state.isSubmitting = true
        state.errorBanner = nil
        let id = state.offer.id
        return .run { [offersAPI] send in
          do {
            let updated = try await offersAPI.accept(id)
            await send(.acceptResponse(.success(updated)))
          } catch {
            await send(.acceptResponse(.failure(OfferErrorBox(error))))
          }
        }
        .cancellable(id: CancelID.accept, cancelInFlight: true)

      case .declineTapped:
        guard state.canRespond else { return .none }
        state.isSubmitting = true
        state.errorBanner = nil
        let id = state.offer.id
        return .run { [offersAPI] send in
          do {
            let updated = try await offersAPI.decline(id, nil)
            await send(.declineResponse(.success(updated)))
          } catch {
            await send(.declineResponse(.failure(OfferErrorBox(error))))
          }
        }
        .cancellable(id: CancelID.decline, cancelInFlight: true)

      case .acceptResponse(.success(let updated)):
        state.isSubmitting = false
        state.offer = updated
        return .merge(
          .cancel(id: CancelID.tick),
          .send(.delegate(.accepted(updated)))
        )

      case .acceptResponse(.failure(let box)):
        state.isSubmitting = false
        if box.isOfferTaken {
          let id = state.offer.id
          return .merge(
            .cancel(id: CancelID.tick),
            .send(.delegate(.unavailable(offerId: id)))
          )
        }
        state.errorBanner = box.userFacingMessage()
        return .none

      case .declineResponse(.success(let updated)):
        state.isSubmitting = false
        state.offer = updated
        let id = updated.id
        return .merge(
          .cancel(id: CancelID.tick),
          .send(.delegate(.declined(offerId: id)))
        )

      case .declineResponse(.failure(let box)):
        state.isSubmitting = false
        // Decline failures on a still-offered row are recoverable —
        // surface the banner and let the driver retry. A 409 on
        // decline means the row already left `offered` (likely
        // expired or accepted by sibling), which we treat as a
        // successful exit — the offer is gone either way.
        if box.isOfferTaken {
          let id = state.offer.id
          return .merge(
            .cancel(id: CancelID.tick),
            .send(.delegate(.declined(offerId: id)))
          )
        }
        state.errorBanner = box.userFacingMessage()
        return .none

      case .errorBannerDismissed:
        state.errorBanner = nil
        return .none

      case .delegate:
        return .none
      }
    }
  }
}

/// Equatable wrapper around the dispatch-offer error surface so the
/// reducer's actions stay Equatable for TestStore matching. Mirrors
/// the ``ShiftErrorBox`` pattern; this box additionally classifies
/// the 409 / `OFFER_NO_LONGER_AVAILABLE` cluster as ``offerTaken``
/// because the offer card UX branches on that case (sheet dismisses
/// without an angry banner).
public struct OfferErrorBox: Error, Equatable, Sendable {
  public enum Kind: Equatable, Sendable {
    case offerTaken
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
      case .malformedPayload(let label):
        self.kind = .malformed(label)
      case .unimplemented(let name):
        self.kind = .other(name)
      }
      return
    }
    if let apiError = error as? APIError {
      switch apiError {
      case .server(let status, let envelope):
        if status == 409
          || envelope.error.code == "OFFER_NO_LONGER_AVAILABLE"
          || envelope.error.code == "OFFER_NOT_OFFERED"
          || envelope.error.code == "OFFER_EXPIRED"
        {
          self.kind = .offerTaken
        } else {
          self.kind = .server(message: envelope.error.message, code: envelope.error.code)
        }
      case .transport:
        self.kind = .transport
      case .unauthorized, .noRefreshToken:
        self.kind = .unauthorized
      case .unexpectedStatus, .decoding, .configuration:
        self.kind = .other(String(describing: apiError))
      }
      return
    }
    self.kind = .other(String(describing: error))
  }

  public var isOfferTaken: Bool {
    if case .offerTaken = kind { return true }
    return false
  }

  public func userFacingMessage() -> String {
    switch kind {
    case .offerTaken: "Offer no longer available."
    case .transport: "Couldn't reach DankDash. Check your connection."
    case .unauthorized: "Sign in again to continue."
    case .malformed: "Couldn't read the response. We'll try again."
    case .server(let message, _): message
    case .other(let message): message
    }
  }
}
