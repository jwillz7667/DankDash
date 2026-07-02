import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Read-side counterpart to ``DispatchOfferAPIClient``. Exposes a single
/// `AsyncStream<DispatchOffer>` that yields every fresh offer the
/// authenticated driver is presented with.
///
/// The live binding implements a 10-second polling fallback against
/// `GET /v1/driver/offers/pending` — chosen because the `/driver`
/// Socket.io namespace is deferred to Phase 22 and offers are
/// time-critical (30-second acceptance window). Once Phase 22 lights up
/// the namespace, the live binding swaps to a socket subscription and
/// every consumer of this client (the shift home reducer) stays
/// unchanged — the seam is the AsyncStream, not the transport.
///
/// **De-duplication.** The stream tracks `id`s it has already emitted
/// in its private continuation so the same offer doesn't fan out
/// twice if it appears on consecutive polls (it will, every 10s until
/// the driver responds). The reducer downstream is also defensive: it
/// only mounts the offer sheet when the offer id differs from the
/// currently-presented one.
///
/// **Cancellation.** Closing the stream's continuation is the caller's
/// signal to stop polling — the shift home reducer cancels its
/// subscription effect when the driver goes offline.
public struct OfferSubscriptionClient: Sendable {
  public var stream: @Sendable () -> AsyncStream<DispatchOffer>

  /// One-shot authoritative read of the driver's currently-pending offers.
  /// Driven by the `/driver` socket's `offer:new` push: the pushed envelope
  /// carries only ids, so the shift home fetches the full offer list here
  /// and mounts it via the same path the 10s poll uses. Returns only
  /// `offered`, non-expired offers (same filter as ``stream``).
  public var fetchPending: @Sendable () async throws -> [DispatchOffer]

  public init(
    stream: @Sendable @escaping () -> AsyncStream<DispatchOffer>,
    // Defaulted so existing call sites (tests that synthesize a stream
    // directly) compile unchanged.
    fetchPending: @Sendable @escaping () async throws -> [DispatchOffer] = { [] }
  ) {
    self.stream = stream
    self.fetchPending = fetchPending
  }
}

public extension OfferSubscriptionClient {
  /// Server poll cadence. Matches the Phase 20 plan ("Offers come via
  /// 10s polling fallback in foreground; background offer delivery uses
  /// APNs"). Exposed publicly so reducer tests can synthesize the same
  /// duration via `TestClock.advance`.
  static let pollInterval: Duration = .seconds(10)

  /// Live implementation. Polls `GET /v1/driver/offers/pending` every
  /// 10 seconds; yields each offer id at most once per session. A
  /// network or decoding failure on any single poll is swallowed — the
  /// next tick retries. Tearing the stream down cancels the polling
  /// task via the per-subscription `Task` cancellation handle.
  static func live(apiClient: APIClient) -> OfferSubscriptionClient {
    OfferSubscriptionClient(
      stream: {
        AsyncStream { continuation in
          let task = Task {
            var seen = Set<UUID>()
            while !Task.isCancelled {
              do {
                let dto = try await apiClient.send(DriverOffersEndpoints.pendingOffers())
                for offer in dto.toDomain() where offer.status == .offered {
                  guard !seen.contains(offer.id) else { continue }
                  if offer.isExpired() { continue }
                  seen.insert(offer.id)
                  continuation.yield(offer)
                }
              } catch {
                // Polling is best-effort — connection loss, auth blip,
                // or a 5xx all fall through to the next tick. The
                // reducer's heartbeat will surface broader connectivity
                // problems through its own banner.
              }
              try? await Task.sleep(for: pollInterval)
            }
            continuation.finish()
          }
          continuation.onTermination = { _ in task.cancel() }
        }
      },
      fetchPending: {
        let dto = try await apiClient.send(DriverOffersEndpoints.pendingOffers())
        return dto.toDomain().filter { $0.status == .offered && !$0.isExpired() }
      }
    )
  }

  /// Test implementation that never yields. Reducer tests synthesize
  /// the stream directly (via `AsyncStream<DispatchOffer>.makeStream`)
  /// and inject a client whose `stream` closure returns the test
  /// stream — this default exists so a forgotten override surfaces as
  /// "no offers ever arrive" rather than a TestStore failure on the
  /// live binding.
  static let unimplemented = OfferSubscriptionClient(
    stream: { AsyncStream { $0.finish() } }
  )
}

private enum OfferSubscriptionClientKey: DependencyKey {
  static let liveValue: OfferSubscriptionClient = .unimplemented
  static let testValue: OfferSubscriptionClient = .unimplemented
}

public extension DependencyValues {
  var offerSubscriptionClient: OfferSubscriptionClient {
    get { self[OfferSubscriptionClientKey.self] }
    set { self[OfferSubscriptionClientKey.self] = newValue }
  }
}
