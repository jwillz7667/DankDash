import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// Search surface: a sticky query field at the top, a facet rail
/// (categories + strain types) below it, and a 2-column LazyVGrid of
/// `SearchProductResult` cards.
///
/// The search field commits keystrokes immediately into the reducer
/// (`queryChanged`); the reducer debounces the actual network call.
/// Pagination triggers when the last visible cell appears via
/// `.onAppear` — no `List` here, so we manually emit `paginate` when the
/// final row mounts.
struct SearchView: View {
  @Bindable var store: StoreOf<SearchFeature>
  @Dependency(\.cdnBaseURL) private var cdnBaseURL
  @FocusState private var queryFocused: Bool

  private let columns: [GridItem] = [
    GridItem(.flexible(), spacing: DankSpacing.sm),
    GridItem(.flexible(), spacing: DankSpacing.sm),
  ]

  var body: some View {
    VStack(spacing: 0) {
      searchHeader
      facetRail
      resultsBody
    }
    .background(DankColor.cream.ignoresSafeArea())
    .navigationTitle("Search")
    .navigationBarTitleDisplayMode(.inline)
  }

  private var searchHeader: some View {
    HStack(spacing: DankSpacing.xs) {
      Image(systemName: "magnifyingglass")
        .foregroundStyle(DankColor.Text.muted)
        .accessibilityHidden(true)
      TextField(
        "Search strains, brands, edibles",
        text: Binding(
          get: { store.query },
          set: { store.send(.queryChanged($0)) }
        )
      )
      .textInputAutocapitalization(.never)
      .autocorrectionDisabled()
      .focused($queryFocused)
      .submitLabel(.search)

      if !store.query.isEmpty {
        Button {
          store.send(.clearQueryTapped)
        } label: {
          Image(systemName: "xmark.circle.fill")
            .foregroundStyle(DankColor.Text.muted)
        }
        .accessibilityLabel("Clear search")
      }
    }
    .padding(.horizontal, DankSpacing.md)
    .padding(.vertical, DankSpacing.sm)
    .background(DankColor.primary.opacity(0.06))
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
    .padding(.horizontal, DankSpacing.md)
    .padding(.top, DankSpacing.sm)
  }

  @ViewBuilder private var facetRail: some View {
    let hasFacets = !store.strainTypeFacets.isEmpty || !store.categoryFacets.isEmpty
    if hasFacets || store.hasActiveFacets {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: DankSpacing.xs) {
          if store.hasActiveFacets {
            FacetPill(title: "Clear", isSelected: false, action: {
              store.send(.clearFacetsTapped)
            })
          }
          ForEach(store.strainTypeFacets, id: \.strainType) { facet in
            FacetPill(
              title: facet.strainType.rawValue.capitalized,
              count: facet.count,
              isSelected: store.selectedStrainType == facet.strainType,
              action: {
                let new = store.selectedStrainType == facet.strainType ? nil : facet.strainType
                store.send(.strainFacetTapped(new))
              }
            )
          }
          ForEach(store.categoryFacets, id: \.categoryId) { facet in
            FacetPill(
              title: "Category",
              count: facet.count,
              isSelected: store.selectedCategoryId == facet.categoryId,
              action: {
                let new = store.selectedCategoryId == facet.categoryId ? nil : facet.categoryId
                store.send(.categoryFacetTapped(new))
              }
            )
          }
        }
        .padding(.horizontal, DankSpacing.md)
        .padding(.vertical, DankSpacing.xs)
      }
    }
  }

  @ViewBuilder private var resultsBody: some View {
    if !store.hasActiveQuery {
      EmptyStateView(
        systemImage: "magnifyingglass",
        title: "Start typing",
        message: "Search for a brand, strain, edible, or effect — three letters is enough."
      )
    } else if store.isLoading && store.results.isEmpty {
      VStack(spacing: DankSpacing.md) {
        Spacer()
        DankLoader()
        Text("Searching…")
          .font(DankFont.body)
          .foregroundStyle(DankColor.Text.muted)
        Spacer()
      }
    } else if let error = store.error, store.results.isEmpty {
      EmptyStateView(
        systemImage: "wifi.slash",
        title: "Search hit a snag",
        message: error
      )
    } else if store.results.isEmpty {
      EmptyStateView(
        systemImage: "leaf",
        title: "No matches",
        message: "Try a broader term or clear your filters."
      )
    } else {
      ScrollView {
        LazyVGrid(columns: columns, spacing: DankSpacing.sm) {
          ForEach(store.results) { result in
            SearchResultTile(
              result: result,
              cdnBaseURL: cdnBaseURL,
              action: { store.send(.productTapped(result.id)) }
            )
            .onAppear {
              if result.id == store.results.last?.id, store.canLoadNextPage {
                store.send(.paginate)
              }
            }
          }
          if store.isLoadingNextPage {
            DankLoader()
              .gridCellColumns(2)
              .padding(.vertical, DankSpacing.sm)
          }
        }
        .padding(DankSpacing.md)
      }
    }
  }
}

private struct SearchResultTile: View {
  let result: SearchProductResult
  let cdnBaseURL: URL?
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(alignment: .leading, spacing: DankSpacing.xs) {
        DankAsyncImage(
          imageKey: result.imageKeys.first,
          cdnBaseURL: cdnBaseURL,
          contentMode: .fill,
          aspectRatio: 1
        )
        .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))

        HStack(spacing: DankSpacing.xxs) {
          Circle()
            .fill(ProductTile.strainTint(result.strainType))
            .frame(width: 8, height: 8)
            .accessibilityHidden(true)
          Text(result.brand.uppercased())
            .font(DankFont.caption)
            .tracking(0.8)
            .foregroundStyle(DankColor.Text.secondary)
            .lineLimit(1)
          Spacer(minLength: 0)
        }

        Text(result.name)
          .font(DankFont.bodySmall.weight(.semibold))
          .foregroundStyle(DankColor.Text.primary)
          .lineLimit(2, reservesSpace: true)
          .multilineTextAlignment(.leading)

        Text(ProductTile.formatTHC(result.thcMgPerUnit, weight: result.weightGramsPerUnit))
          .font(DankFont.caption)
          .foregroundStyle(DankColor.Text.secondary)
      }
      .padding(DankSpacing.sm)
      .background(DankColor.cream)
      .clipShape(RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous)
          .strokeBorder(DankColor.primary.opacity(0.08), lineWidth: 1)
      )
      .shadow(color: DankColor.primaryDark.opacity(0.06), radius: 8, x: 0, y: 4)
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(result.brand) \(result.name)")
    .accessibilityAddTraits(.isButton)
  }
}
