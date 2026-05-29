import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// Paginated list bound to ``OrderHistoryFeature``. Tab segment toggles
/// the `active|completed|all` filter; pull-to-refresh routes through
/// the reducer's `.pullToRefresh` action; an invisible `.onAppear`
/// sentinel under the last row dispatches `.paginate` to load the next
/// cursor page.
///
/// The dispensary name shown on each row is keyed off the row's
/// `dispensaryId` and resolved through an injected lookup map. Phase 18
/// passes an empty dictionary (the dispensary name displays as nil → the
/// row falls back to date-only), since the catalog feature owns the
/// dispensary cache and a cross-feature read isn't wired yet. The next
/// catalog refresh that lands dispensary lookup into Browse will plug
/// straight in here.
struct OrderHistoryView: View {
  @Bindable var store: StoreOf<OrderHistoryFeature>
  let dispensaryNames: [UUID: String]
  let now: Date

  init(
    store: StoreOf<OrderHistoryFeature>,
    dispensaryNames: [UUID: String] = [:],
    now: Date = Date()
  ) {
    self.store = store
    self.dispensaryNames = dispensaryNames
    self.now = now
  }

  var body: some View {
    VStack(spacing: 0) {
      filterPicker
        .padding(.horizontal, DankSpacing.md)
        .padding(.top, DankSpacing.sm)
        .padding(.bottom, DankSpacing.sm)

      content
    }
    .background(DankColor.cream.ignoresSafeArea())
    .navigationTitle("Orders")
    .navigationBarTitleDisplayMode(.inline)
    .task { store.send(.onAppear) }
    .refreshable { await refresh() }
  }

  // MARK: - Filter picker

  private var filterPicker: some View {
    Picker(
      "Filter",
      selection: Binding(
        get: { store.statusFilter },
        set: { store.send(.filterChanged($0)) }
      )
    ) {
      ForEach(OrderListStatusFilter.allCases, id: \.self) { filter in
        Text(filterLabel(filter)).tag(filter)
      }
    }
    .pickerStyle(.segmented)
    .accessibilityLabel("Order filter")
  }

  private func filterLabel(_ filter: OrderListStatusFilter) -> String {
    switch filter {
    case .active: return "Active"
    case .completed: return "Past"
    case .all: return "All"
    }
  }

  // MARK: - Content

  @ViewBuilder private var content: some View {
    if store.isLoading && store.items.isEmpty {
      loadingPlaceholder
    } else if let error = store.error, store.items.isEmpty {
      errorState(error)
    } else if store.showsEmptyState {
      emptyState
    } else {
      listScroll
    }
  }

  private var listScroll: some View {
    ScrollView {
      VStack(spacing: 0) {
        if let error = store.error {
          errorBanner(error)
            .padding(.horizontal, DankSpacing.md)
            .padding(.bottom, DankSpacing.sm)
        }

        VStack(spacing: 0) {
          ForEach(Array(store.items.enumerated()), id: \.element.id) { index, item in
            OrderListRow(
              item: item,
              dispensaryName: dispensaryNames[item.dispensaryId],
              now: now,
              action: { store.send(.orderTapped(item.id)) }
            )
            .padding(.horizontal, DankSpacing.md)

            if index != store.items.count - 1 {
              Divider().background(DankColor.primary.opacity(0.08))
            }
          }
        }
        .background(DankColor.cream)
        .clipShape(RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous)
            .strokeBorder(DankColor.primary.opacity(0.08), lineWidth: 1)
        )
        .padding(.horizontal, DankSpacing.md)

        if store.canLoadNextPage {
          paginationSentinel
        } else if store.isPaginating {
          paginatingIndicator
        }
      }
      .padding(.vertical, DankSpacing.sm)
    }
  }

  // MARK: - Pagination sentinel

  /// Invisible row that fires `.paginate` once when scrolled into view.
  /// Re-creates per page via `.id(store.nextCursor)` so a fresh cursor
  /// re-arms the sentinel — without the id binding SwiftUI would
  /// recycle the same view and `.onAppear` wouldn't re-fire after a
  /// successful next-page load.
  private var paginationSentinel: some View {
    Color.clear
      .frame(height: 1)
      .onAppear { store.send(.paginate) }
      .id(store.nextCursor)
      .accessibilityHidden(true)
  }

  private var paginatingIndicator: some View {
    HStack(spacing: DankSpacing.sm) {
      ProgressView().controlSize(.small)
      Text("Loading more orders…")
        .font(DankFont.caption)
        .foregroundStyle(DankColor.Text.muted)
    }
    .padding(.vertical, DankSpacing.md)
    .frame(maxWidth: .infinity)
  }

  // MARK: - Empty / error / loading states

  private var emptyState: some View {
    EmptyStateView(
      systemImage: "shippingbox",
      title: emptyStateTitle,
      message: emptyStateMessage
    )
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var emptyStateTitle: String {
    switch store.statusFilter {
    case .active: return "No active orders"
    case .completed: return "No past orders"
    case .all: return "No orders yet"
    }
  }

  private var emptyStateMessage: String {
    switch store.statusFilter {
    case .active:
      return "Once you place an order it'll show up here while it's on the way."
    case .completed:
      return "Past orders appear here after they're delivered or canceled."
    case .all:
      return "Browse the feed and place your first order — it'll appear here while it's on the way."
    }
  }

  private func errorState(_ message: String) -> some View {
    EmptyStateView(
      systemImage: "exclamationmark.triangle",
      title: "Couldn't load orders",
      message: message,
      actionTitle: "Try again",
      action: { store.send(.retryFirstPageTapped) }
    )
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var loadingPlaceholder: some View {
    VStack(spacing: DankSpacing.md) {
      ProgressView().controlSize(.large)
      Text("Loading orders…")
        .font(DankFont.body)
        .foregroundStyle(DankColor.Text.secondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private func errorBanner(_ message: String) -> some View {
    HStack(alignment: .top, spacing: DankSpacing.xs) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(DankColor.Semantic.danger)
        .accessibilityHidden(true)
      Text(message)
        .font(DankFont.bodySmall)
        .foregroundStyle(DankColor.Text.primary)
      Spacer(minLength: 0)
    }
    .padding(DankSpacing.md)
    .background(DankColor.Semantic.danger.opacity(0.08))
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Error: \(message)")
  }

  // MARK: - Refresh

  /// SwiftUI's `.refreshable` modifier expects an async closure; the
  /// reducer's refresh is fire-and-forget, so we poll `isRefreshing`
  /// briefly to keep the system spinner alive until the load resolves.
  /// This matches the pattern used by the storefront list and avoids
  /// adding a tracked-effect surface just for the spinner duration.
  private func refresh() async {
    store.send(.pullToRefresh)
    while store.isRefreshing {
      try? await Task.sleep(for: .milliseconds(120))
    }
  }
}
