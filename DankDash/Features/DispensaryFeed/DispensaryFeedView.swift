import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// Top of the consumer app. Three states:
///   1. Permission undetermined → `LocationPermissionPromptView`.
///   2. Permission resolved + fetch in-flight or done → sectioned list of
///      `DispensaryCard`s, pull-to-refresh, offline banner when serving
///      the cached snapshot.
///   3. Permission resolved + zero dispensaries → empty state.
struct DispensaryFeedView: View {
  @Bindable var store: StoreOf<DispensaryFeedFeature>
  @Dependency(\.cdnBaseURL) private var cdnBaseURL

  var body: some View {
    Group {
      if store.authorizationStatus == .notDetermined {
        LocationPermissionPromptView(store: store)
      } else {
        feedContent
      }
    }
    .navigationTitle("DankDash")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .principal) {
        DankLogo(.wordmark, size: 28)
          .accessibilityHidden(true)
      }
    }
    .background(DankColor.cream.ignoresSafeArea())
    .task {
      store.send(.task)
    }
  }

  @ViewBuilder private var feedContent: some View {
    let sections = store.sections
    if sections.isEmpty {
      if store.isLoading {
        VStack(spacing: DankSpacing.md) {
          Spacer()
          DankLoader()
          Text("Finding dispensaries near you…")
            .font(DankFont.body)
            .foregroundStyle(DankColor.Text.muted)
          Spacer()
        }
      } else if let error = store.error {
        EmptyStateView(
          systemImage: "wifi.slash",
          title: "Something went wrong",
          message: error,
          actionTitle: "Try again",
          action: { store.send(.fetchRequested) }
        )
      } else if store.hasAttemptedFetch {
        EmptyStateView(
          systemImage: "leaf",
          title: "No dispensaries yet",
          message: "We couldn't find dispensaries delivering here right now. Try expanding your area or check back soon."
        )
      } else {
        Spacer()
      }
    } else {
      ScrollView {
        LazyVStack(spacing: DankSpacing.lg, pinnedViews: []) {
          if store.isShowingFromCache {
            offlineBanner
          }
          ForEach(sections) { section in
            VStack(alignment: .leading, spacing: DankSpacing.sm) {
              SectionHeader(eyebrow: section.kind.eyebrow, title: section.kind.title)
                .padding(.horizontal, DankSpacing.md)
              ForEach(section.dispensaries) { dispensary in
                DispensaryCard(
                  dispensary: dispensary,
                  cdnBaseURL: cdnBaseURL,
                  action: { store.send(.dispensaryTapped(dispensary.id)) }
                )
                .padding(.horizontal, DankSpacing.md)
              }
            }
          }
          Color.clear.frame(height: DankSpacing.lg)
        }
      }
      .refreshable {
        store.send(.pullToRefresh)
      }
    }
  }

  private var offlineBanner: some View {
    HStack(spacing: DankSpacing.xs) {
      Image(systemName: "wifi.slash")
        .accessibilityHidden(true)
      Text("Showing your last results. Pull to refresh.")
        .font(DankFont.caption)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, DankSpacing.md)
    .padding(.vertical, DankSpacing.sm)
    .foregroundStyle(DankColor.Text.primary)
    .background(DankColor.accent.opacity(0.18))
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
    .padding(.horizontal, DankSpacing.md)
    .accessibilityLabel("Showing offline results. Pull down to refresh.")
  }
}
