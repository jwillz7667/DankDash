import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashFeatures

/// Thin wrapper around ``RatingSheet`` that owns the local star + comment
/// state for the post-delivery feedback prompt. The Phase-18 backend has
/// no `PATCH /v1/orders/:id/rating` endpoint yet (see the plan's
/// "Deferred" section), so both Submit and Skip route through the same
/// `.dismissRatingSheet` action — the parent reducer tears down the
/// sheet and cancels the 5-minute rating timer.
///
/// Rating + comment live as `@State` here (not in the reducer) because
/// the wire submission is a no-op stub; persisting them across the
/// sheet's lifetime would only carry value once the real endpoint
/// lands in Phase 19+.
struct RatingSheetView: View {
  @Bindable var store: StoreOf<OrderTrackingFeature>

  @State private var rating: Int = 0
  @State private var comment: String = ""

  var body: some View {
    RatingSheet(
      rating: $rating,
      comment: $comment,
      isSubmitting: false,
      onSubmit: { store.send(.dismissRatingSheet) },
      onSkip: { store.send(.dismissRatingSheet) }
    )
  }
}
