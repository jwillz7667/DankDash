import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// Single-dispensary storefront: hero, hours/rating, sticky category tab
/// bar, and a 2-column LazyVGrid of `ProductTile`. The filter button on
/// the trailing toolbar toggles the filter sheet, which mutates `state
/// .filter` via `filterChanged` (the sheet view binds to that).
struct StorefrontView: View {
  @Bindable var store: StoreOf<StorefrontFeature>
  @Dependency(\.cdnBaseURL) private var cdnBaseURL

  private let columns: [GridItem] = [
    GridItem(.flexible(), spacing: DankSpacing.sm),
    GridItem(.flexible(), spacing: DankSpacing.sm),
  ]

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: DankSpacing.lg, pinnedViews: [.sectionHeaders]) {
        hero
        if store.isShowingFromCache {
          offlineBanner
            .padding(.horizontal, DankSpacing.md)
        }
        if let error = store.error, store.menuItems.isEmpty {
          EmptyStateView(
            systemImage: "wifi.slash",
            title: "We hit a snag",
            message: error,
            actionTitle: "Try again",
            action: { store.send(.pullToRefresh) }
          )
        } else {
          Section {
            menuGrid
          } header: {
            categoryBar
          }
        }
      }
    }
    .refreshable {
      store.send(.pullToRefresh)
    }
    .background(DankColor.cream.ignoresSafeArea())
    .navigationTitle(store.dispensary?.displayName ?? "Storefront")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          store.send(.filterButtonTapped)
        } label: {
          Image(systemName: store.filter.isActive
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle")
            .foregroundStyle(DankColor.primary)
        }
        .accessibilityLabel(store.filter.isActive ? "Filters active" : "Filter menu")
      }
    }
    .sheet(isPresented: Binding(
      get: { store.isShowingFilterSheet },
      set: { open in
        if !open { store.send(.filterDismissed) }
      }
    )) {
      MenuFilterSheetView(
        filter: Binding(
          get: { store.filter },
          set: { store.send(.filterChanged($0)) }
        ),
        onCleared: { store.send(.filterCleared) },
        onDismiss: { store.send(.filterDismissed) }
      )
    }
    .task {
      store.send(.task)
    }
  }

  @ViewBuilder private var hero: some View {
    ZStack(alignment: .bottomLeading) {
      DankAsyncImage(
        imageKey: store.dispensary?.heroImageKey,
        cdnBaseURL: cdnBaseURL,
        contentMode: .fill,
        aspectRatio: 16.0 / 9.0
      )

      LinearGradient(
        colors: [
          Color.black.opacity(0.0),
          Color.black.opacity(0.45),
          Color.black.opacity(0.75),
        ],
        startPoint: .top,
        endPoint: .bottom
      )
      .allowsHitTesting(false)

      VStack(alignment: .leading, spacing: DankSpacing.xs) {
        if let dispensary = store.dispensary {
          HStack(spacing: DankSpacing.xs) {
            statusBadge(for: dispensary)
            if let rating = dispensary.ratingAvg {
              HStack(spacing: 2) {
                Image(systemName: "star.fill")
                  .font(.system(size: 11, weight: .semibold))
                Text(Self.ratingFormatter.string(from: rating as NSDecimalNumber) ?? "—")
                  .font(DankFont.caption)
                Text("(\(dispensary.ratingCount))")
                  .font(DankFont.caption)
                  .opacity(0.85)
              }
              .foregroundStyle(DankColor.Text.onPrimary)
              .padding(.horizontal, DankSpacing.xs)
              .padding(.vertical, DankSpacing.xxs)
              .background(DankColor.primaryDark.opacity(0.55))
              .clipShape(Capsule())
            }
            Spacer(minLength: 0)
          }
          Text(dispensary.displayName)
            .font(DankFont.title)
            .foregroundStyle(DankColor.Text.onPrimary)
            .lineLimit(2)
          Text("\(dispensary.addressLine1) · \(dispensary.city), \(dispensary.region)")
            .font(DankFont.bodySmall)
            .foregroundStyle(DankColor.Text.onPrimary.opacity(0.9))
            .lineLimit(1)
        } else {
          ProgressView()
            .progressViewStyle(.circular)
            .tint(.white)
        }
      }
      .padding(DankSpacing.md)
    }
    .frame(maxWidth: .infinity)
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous))
    .padding(.horizontal, DankSpacing.md)
    .padding(.top, DankSpacing.sm)
  }

  @ViewBuilder private func statusBadge(for dispensary: Dispensary) -> some View {
    if dispensary.isOpenNow {
      DankBadge("Open now", tone: .success)
    } else if let opensAt = dispensary.opensAt {
      DankBadge("Opens \(Self.timeFormatter.string(from: opensAt))", tone: .warning)
    } else {
      DankBadge("Closed", tone: .neutral)
    }
  }

  private var categoryBar: some View {
    VStack(spacing: 0) {
      CategoryTabBar(
        items: store.visibleCategories.map {
          CategoryTabBar.Item(id: $0.id.uuidString, title: $0.displayName)
        },
        selection: Binding(
          get: { store.selectedCategoryId?.uuidString },
          set: { id in
            store.send(.categorySelected(id.flatMap(UUID.init(uuidString:))))
          }
        )
      )
      Rectangle()
        .fill(DankColor.primary.opacity(0.08))
        .frame(height: 1)
    }
    .background(DankColor.cream)
  }

  @ViewBuilder private var menuGrid: some View {
    let items = store.filteredItems
    if items.isEmpty {
      EmptyStateView(
        systemImage: "leaf",
        title: "Nothing matches",
        message: store.filter.isActive
          ? "Adjust your filters or clear them to see more."
          : "This dispensary doesn't have items in this category right now.",
        actionTitle: store.filter.isActive ? "Clear filters" : nil,
        action: store.filter.isActive ? { store.send(.filterCleared) } : nil
      )
      .padding(.horizontal, DankSpacing.md)
    } else {
      LazyVGrid(columns: columns, spacing: DankSpacing.sm) {
        ForEach(items) { item in
          ProductTile(
            menuItem: item,
            cdnBaseURL: cdnBaseURL,
            action: { store.send(.productTapped(productId: item.product.id, listingId: item.listingId)) }
          )
        }
      }
      .padding(.horizontal, DankSpacing.md)
      .padding(.bottom, DankSpacing.lg)
    }
  }

  private var offlineBanner: some View {
    HStack(spacing: DankSpacing.xs) {
      Image(systemName: "wifi.slash")
        .accessibilityHidden(true)
      Text("Showing your last visit. Pull to refresh.")
        .font(DankFont.caption)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, DankSpacing.md)
    .padding(.vertical, DankSpacing.sm)
    .foregroundStyle(DankColor.Text.primary)
    .background(DankColor.accent.opacity(0.18))
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
  }

  private static let ratingFormatter: NumberFormatter = {
    let f = NumberFormatter()
    f.minimumFractionDigits = 1
    f.maximumFractionDigits = 1
    return f
  }()

  private static let timeFormatter: DateFormatter = {
    let f = DateFormatter()
    f.timeStyle = .short
    f.dateStyle = .none
    return f
  }()
}
