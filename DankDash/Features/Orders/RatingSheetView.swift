import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashFeatures

/// Thin wrapper around ``RatingSheet`` that binds the post-delivery
/// feedback prompt to ``OrderTrackingFeature``. Star + comment live in
/// reducer state (not `@State`) so the submit effect can read them and so
/// partial input survives the sheet being dismissed and re-presented.
///
/// Submit posts the rating to `POST /v1/orders/:id/rate` via
/// `.submitRatingTapped`; on success the reducer dismisses the sheet and
/// retires the prompt. Skip routes through `.dismissRatingSheet`, which
/// tears down the sheet and cancels the 5-minute rating timer without
/// sending anything to the server.
struct RatingSheetView: View {
  @Bindable var store: StoreOf<OrderTrackingFeature>

  var body: some View {
    RatingSheet(
      rating: Binding(
        get: { store.rating },
        set: { store.send(.ratingChanged($0)) }
      ),
      comment: Binding(
        get: { store.ratingComment },
        set: { store.send(.ratingCommentChanged($0)) }
      ),
      isSubmitting: store.isSubmittingRating,
      errorMessage: store.ratingError,
      onSubmit: { store.send(.submitRatingTapped) },
      onSkip: { store.send(.dismissRatingSheet) }
    )
  }
}
