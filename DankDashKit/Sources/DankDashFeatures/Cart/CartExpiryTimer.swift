import Foundation

/// Thin wrapper over a ``ContinuousClock``-driven 30-second ticker. The
/// ticker fires `expiryTick` actions into ``CartFeature`` so the cart
/// expiry banner stays current and an expired cart wipes itself even if
/// the user idles on the cart screen.
///
/// Lifted into its own type so the test suite can substitute a fake
/// clock (`TestClock`) and advance time manually rather than wall-clock
/// waiting. The 30-second cadence is coarse enough that one tick / minute
/// is plenty for the countdown banner, while staying fine enough that
/// expiry catches within the same screen visit.
public enum CartExpiryTimer {
  /// Cadence between ticks. Picked deliberately at 30s so the banner
  /// updates every "half minute" and the worst-case expiry detection
  /// latency is bounded above by the same.
  public static let tickInterval: Duration = .seconds(30)

  /// Returns an `AsyncStream<Void>` that yields once every
  /// ``tickInterval`` against the provided clock. The first yield is
  /// after one full interval — there is no immediate emission so the
  /// reducer's initial state reflects "no tick has fired yet" until
  /// the first tick lands.
  public static func ticks(clock: any Clock<Duration>) -> AsyncStream<Void> {
    AsyncStream { continuation in
      let task = Task {
        while !Task.isCancelled {
          try? await clock.sleep(for: tickInterval)
          guard !Task.isCancelled else { break }
          continuation.yield()
        }
        continuation.finish()
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }
}
