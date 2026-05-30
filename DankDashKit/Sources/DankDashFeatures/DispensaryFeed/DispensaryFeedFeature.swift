import Foundation
import ComposableArchitecture
import DankDashDomain

/// "Home" of the consumer app — the dispensary feed. Manages the
/// permission grant flow, geolocated fetch, section grouping, pull-to-
/// refresh, and offline-cache fallback. On launch it reads the cache
/// first so the UI paints something before the network round-trip
/// resolves; the network response then overwrites the cached snapshot.
///
/// The section grouping (`Delivering Now`, `Top Rated`, `New`, `Closing
/// Soon`) is computed client-side from the server's pre-resolved
/// `isOpenNow`, `opensAt`, `ratingAvg`, `createdAt`, and `hours` so the
/// reducer is the single source of truth for the feed's structure.
@Reducer
public struct DispensaryFeedFeature: Sendable {
  /// Maximum cached-snapshot age that still counts as "good enough" to
  /// render when the network is unavailable. Beyond 24h the feed renders
  /// the empty state instead.
  static let staleAfter: TimeInterval = 60 * 60 * 24

  @ObservableState
  public struct State: Equatable, Sendable {
    public var authorizationStatus: LocationAuthorizationStatus
    public var coordinate: Coordinate?
    public var dispensaries: [Dispensary]
    public var isLoading: Bool
    public var isShowingFromCache: Bool
    public var error: String?
    public var hasAttemptedFetch: Bool

    public init(
      authorizationStatus: LocationAuthorizationStatus = .notDetermined,
      coordinate: Coordinate? = nil,
      dispensaries: [Dispensary] = [],
      isLoading: Bool = false,
      isShowingFromCache: Bool = false,
      error: String? = nil,
      hasAttemptedFetch: Bool = false
    ) {
      self.authorizationStatus = authorizationStatus
      self.coordinate = coordinate
      self.dispensaries = dispensaries
      self.isLoading = isLoading
      self.isShowingFromCache = isShowingFromCache
      self.error = error
      self.hasAttemptedFetch = hasAttemptedFetch
    }

    public var sections: [DispensaryFeedSection] {
      DispensaryFeedSection.sections(from: dispensaries)
    }
  }

  public enum Action: Sendable, Equatable {
    case task
    case cacheLoaded(snapshot: CatalogCacheClient.FeedSnapshot?)
    /// Initial status read from CoreLocation after `.task`. If already
    /// authorized, auto-triggers the location fetch path so we skip the
    /// permission rationale screen on subsequent launches.
    case authorizationStatusResolved(LocationAuthorizationStatus)
    /// Post-prompt status update from inside `.enableLocationTapped`'s
    /// effect. Stores the status without re-triggering the fetch path —
    /// the effect already drives the next step.
    case authorizationStatusChanged(LocationAuthorizationStatus)
    case enableLocationTapped
    case continueWithoutLocationTapped
    case locationResolved(Coordinate?)
    case fetchRequested
    case fetchResponse(Result<[Dispensary], FeedError>)
    case pullToRefresh
    case dispensaryTapped(UUID)
    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Sendable, Equatable {
      case openDispensary(id: UUID)
    }
  }

  /// Narrow error surface so the reducer doesn't carry transport details
  /// past the boundary. The view renders either the snapshot or a
  /// retry-style empty state; this enum is what it switches on.
  public enum FeedError: Error, Sendable, Equatable {
    case transport
    case malformedPayload
    case unknown
  }

  @Dependency(\.locationClient) var location
  @Dependency(\.catalogAPIClient) var api
  @Dependency(\.catalogCacheClient) var cache
  @Dependency(\.date.now) var now

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .task:
        let coordinate = state.coordinate
        return .run { send in
          let snapshot = await cache.readFeed(CatalogCacheClient.feedKey(for: coordinate))
          await send(.cacheLoaded(snapshot: snapshot))
          let status = location.authorizationStatus()
          await send(.authorizationStatusResolved(status))
        }

      case .cacheLoaded(let snapshot):
        if let snapshot, !snapshot.dispensaries.isEmpty {
          state.dispensaries = snapshot.dispensaries
          state.isShowingFromCache = true
        }
        return .none

      case .authorizationStatusResolved(let status):
        state.authorizationStatus = status
        if status == .authorized {
          state.isLoading = true
          state.error = nil
          return .run { send in
            do {
              let coordinate = try await location.currentLocation()
              await send(.locationResolved(coordinate))
            } catch {
              await send(.locationResolved(nil))
            }
          }
        }
        return .none

      case .authorizationStatusChanged(let status):
        state.authorizationStatus = status
        return .none

      case .enableLocationTapped:
        state.isLoading = true
        state.error = nil
        return .run { send in
          let granted = await location.requestAuthorization()
          if granted == .authorized {
            await send(.authorizationStatusChanged(granted))
            do {
              let coordinate = try await location.currentLocation()
              await send(.locationResolved(coordinate))
            } catch {
              await send(.locationResolved(nil))
            }
          } else {
            await send(.authorizationStatusChanged(granted))
            await send(.locationResolved(nil))
          }
        }

      case .continueWithoutLocationTapped:
        state.coordinate = nil
        return .send(.fetchRequested)

      case .locationResolved(let coordinate):
        state.coordinate = coordinate
        return .send(.fetchRequested)

      case .fetchRequested:
        state.isLoading = true
        state.error = nil
        state.hasAttemptedFetch = true
        let coordinate = state.coordinate
        let writtenAt = now
        return .run { send in
          do {
            let dispensaries = try await api.listDispensaries(coordinate)
            let snapshot = CatalogCacheClient.FeedSnapshot(
              dispensaries: dispensaries,
              queriedAt: writtenAt
            )
            await cache.writeFeed(CatalogCacheClient.feedKey(for: coordinate), snapshot)
            await send(.fetchResponse(.success(dispensaries)))
          } catch let error as CatalogAPIError {
            switch error {
            case .malformedPayload: await send(.fetchResponse(.failure(.malformedPayload)))
            case .unimplemented: await send(.fetchResponse(.failure(.unknown)))
            }
          } catch {
            await send(.fetchResponse(.failure(.transport)))
          }
        }

      case .fetchResponse(.success(let dispensaries)):
        state.isLoading = false
        state.dispensaries = dispensaries
        state.isShowingFromCache = false
        state.error = nil
        return .none

      case .fetchResponse(.failure(let error)):
        state.isLoading = false
        if !state.dispensaries.isEmpty {
          // We have something cached or previously-loaded. Show the
          // banner; keep the data.
          state.isShowingFromCache = true
        }
        state.error = Self.userMessage(for: error)
        return .none

      case .pullToRefresh:
        return .send(.fetchRequested)

      case .dispensaryTapped(let id):
        return .send(.delegate(.openDispensary(id: id)))

      case .delegate:
        return .none
      }
    }
  }

  static func userMessage(for error: FeedError) -> String {
    switch error {
    case .transport: "We couldn't reach DankDash. We're showing your last results."
    case .malformedPayload: "Something didn't look right in the response. Try again."
    case .unknown: "Something went wrong loading dispensaries."
    }
  }
}

/// A named feed section. The set of sections is computed deterministically
/// from the dispensary list — view layer just renders.
public struct DispensaryFeedSection: Identifiable, Equatable, Sendable {
  public let kind: Kind
  public let dispensaries: [Dispensary]

  public var id: Kind { kind }

  public enum Kind: String, Hashable, Sendable, CaseIterable {
    case deliveringNow
    case topRated
    case newOnDankDash
    case closingSoon

    public var title: String {
      switch self {
      case .deliveringNow: "Delivering now"
      case .topRated: "Top rated"
      case .newOnDankDash: "New on DankDash"
      case .closingSoon: "Closing soon"
      }
    }

    public var eyebrow: String {
      switch self {
      case .deliveringNow: "Near you"
      case .topRated: "Trending"
      case .newOnDankDash: "Recently joined"
      case .closingSoon: "Last call"
      }
    }
  }

  /// Builds the four sections from the unsorted feed. Order:
  ///
  ///   1. `deliveringNow` — every dispensary with `isOpenNow == true`.
  ///   2. `topRated` — `ratingAvg >= 4.5`, sorted descending.
  ///   3. `newOnDankDash` — created within the last 30 days, newest first.
  ///   4. `closingSoon` — open now and closing within 60 minutes of
  ///      `referenceDate` based on the weekday's hours.
  ///
  /// Empty sections are omitted so the view never renders a "Top rated"
  /// header with zero rows.
  public static func sections(
    from dispensaries: [Dispensary],
    referenceDate: Date = Date(),
    timeZone: TimeZone = TimeZone(identifier: "America/Chicago") ?? .gmt
  ) -> [DispensaryFeedSection] {
    let deliveringNow = dispensaries.filter(\.isOpenNow)
    let topRated = dispensaries
      .filter { ($0.ratingAvg ?? 0) >= Decimal(string: "4.5")! }
      .sorted { ($0.ratingAvg ?? 0) > ($1.ratingAvg ?? 0) }
    let calendar: Calendar = {
      var c = Calendar(identifier: .gregorian)
      c.timeZone = timeZone
      return c
    }()
    let cutoff = calendar.date(byAdding: .day, value: -30, to: referenceDate) ?? referenceDate
    let newOnes = dispensaries
      .filter { $0.createdAt >= cutoff }
      .sorted { $0.createdAt > $1.createdAt }
    let closingSoon = dispensaries.filter {
      isClosingSoon($0, referenceDate: referenceDate, timeZone: timeZone)
    }

    var result: [DispensaryFeedSection] = []
    if !deliveringNow.isEmpty { result.append(.init(kind: .deliveringNow, dispensaries: deliveringNow)) }
    if !topRated.isEmpty { result.append(.init(kind: .topRated, dispensaries: topRated)) }
    if !newOnes.isEmpty { result.append(.init(kind: .newOnDankDash, dispensaries: newOnes)) }
    if !closingSoon.isEmpty { result.append(.init(kind: .closingSoon, dispensaries: closingSoon)) }
    return result
  }

  /// "Closing soon" = open now with at most 60 minutes left in the
  /// current weekday's hours window. We re-derive against the actual
  /// hours rather than trusting `opensAt` (server-computed when closed).
  static func isClosingSoon(
    _ dispensary: Dispensary,
    referenceDate: Date,
    timeZone: TimeZone
  ) -> Bool {
    guard dispensary.isOpenNow else { return false }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    let weekday = calendar.component(.weekday, from: referenceDate)
    let day: Weekday = switch weekday {
    case 1: .sunday
    case 2: .monday
    case 3: .tuesday
    case 4: .wednesday
    case 5: .thursday
    case 6: .friday
    case 7: .saturday
    default: .sunday
    }
    guard let hours = dispensary.hours[day] else { return false }
    let startOfDay = calendar.startOfDay(for: referenceDate)
    guard let closeAt = calendar.date(byAdding: .minute, value: hours.closeMinutes, to: startOfDay) else {
      return false
    }
    let remaining = closeAt.timeIntervalSince(referenceDate)
    return remaining > 0 && remaining <= 60 * 60
  }
}
