import SwiftUI

/// Post-delivery rating sheet. Surfaced 5 minutes after `delivered`
/// by `OrderTrackingFeature` (see plan's "Rating timer"). Stateless —
/// the parent reducer owns `rating` + `comment` so the sheet can be
/// reopened without losing partial state. Submit is wired to a stub
/// endpoint in Phase 18; the real PATCH lands in Phase 19+ (see
/// "Deferred" in the plan).
public struct RatingSheet: View {
  @Binding private var rating: Int
  @Binding private var comment: String
  private let isSubmitting: Bool
  private let onSubmit: () -> Void
  private let onSkip: () -> Void

  public init(
    rating: Binding<Int>,
    comment: Binding<String>,
    isSubmitting: Bool = false,
    onSubmit: @escaping () -> Void,
    onSkip: @escaping () -> Void
  ) {
    self._rating = rating
    self._comment = comment
    self.isSubmitting = isSubmitting
    self.onSubmit = onSubmit
    self.onSkip = onSkip
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: DankSpacing.lg) {
      header
      starRow
      commentField
      Spacer(minLength: 0)
      actions
    }
    .padding(DankSpacing.lg)
    .background(DankColor.cream)
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: DankSpacing.xs) {
      Text("How was your delivery?")
        .font(DankFont.title)
        .foregroundStyle(DankColor.Text.primary)
      Text("Your rating helps us match you with great drivers.")
        .font(DankFont.bodySmall)
        .foregroundStyle(DankColor.Text.secondary)
    }
    .accessibilityElement(children: .combine)
  }

  private var starRow: some View {
    HStack(spacing: DankSpacing.sm) {
      ForEach(1...5, id: \.self) { value in
        Button {
          rating = value
        } label: {
          Image(systemName: value <= rating ? "star.fill" : "star")
            .font(.system(size: 32, weight: .semibold))
            .foregroundStyle(value <= rating ? DankColor.Semantic.warning : DankColor.Text.muted)
            .frame(width: 44, height: 44)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(value) star\(value == 1 ? "" : "s")")
        .accessibilityAddTraits(value == rating ? [.isButton, .isSelected] : .isButton)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(starRowAccessibilityLabel)
  }

  private var starRowAccessibilityLabel: String {
    if rating == 0 { return "Rate your delivery, no stars selected" }
    return "Rating, \(rating) of 5 stars"
  }

  private var commentField: some View {
    VStack(alignment: .leading, spacing: DankSpacing.xs) {
      Text("Add a comment (optional)")
        .font(DankFont.caption)
        .foregroundStyle(DankColor.Text.secondary)
      ZStack(alignment: .topLeading) {
        RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous)
          .stroke(DankColor.primary.opacity(0.18), lineWidth: 1)
          .background(
            RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous)
              .fill(.background)
          )
        if comment.isEmpty {
          Text("Tell us what went well — or what didn't.")
            .font(DankFont.body)
            .foregroundStyle(DankColor.Text.muted)
            .padding(.horizontal, DankSpacing.md)
            .padding(.vertical, DankSpacing.sm + 2)
            .allowsHitTesting(false)
        }
        TextEditor(text: $comment)
          .font(DankFont.body)
          .scrollContentBackground(.hidden)
          .padding(.horizontal, DankSpacing.sm)
          .padding(.vertical, DankSpacing.xs)
          .frame(minHeight: 120)
          .accessibilityLabel("Comment")
      }
    }
  }

  private var actions: some View {
    VStack(spacing: DankSpacing.sm) {
      Button(action: onSubmit) {
        HStack(spacing: DankSpacing.xs) {
          if isSubmitting {
            ProgressView()
              .progressViewStyle(.circular)
              .tint(DankColor.Text.onPrimary)
          }
          Text(isSubmitting ? "Submitting…" : "Submit rating")
            .font(DankFont.headline)
        }
        .frame(maxWidth: .infinity, minHeight: 52)
        .padding(.horizontal, DankSpacing.lg)
        .background(canSubmit ? DankColor.primary : DankColor.primary.opacity(0.4))
        .foregroundStyle(DankColor.Text.onPrimary)
        .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
      }
      .disabled(!canSubmit)
      .accessibilityLabel("Submit rating")

      Button(action: onSkip) {
        Text("Maybe later")
          .font(DankFont.body.weight(.semibold))
          .foregroundStyle(DankColor.primary)
          .frame(maxWidth: .infinity, minHeight: 44)
      }
      .accessibilityLabel("Skip rating")
    }
  }

  private var canSubmit: Bool {
    rating > 0 && !isSubmitting
  }
}

#Preview {
  struct Wrapper: View {
    @State var rating: Int = 4
    @State var comment: String = "Driver was friendly."
    var body: some View {
      RatingSheet(
        rating: $rating,
        comment: $comment,
        onSubmit: {},
        onSkip: {}
      )
    }
  }
  return Wrapper()
}
