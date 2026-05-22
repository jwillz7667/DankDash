import SwiftUI
import DankDashDomain

/// Tone-coded pill rendered on the onboarding "pending review" screen.
/// Maps each ``BackgroundCheckStatus`` value to a colored badge so the
/// applicant can tell at a glance where they sit in the pipeline.
///
/// Tones map to the badge palette:
/// - `.notStarted` → neutral (muted primary @ 12%)
/// - `.inReview` → warning amber
/// - `.passed` → success green
public struct BackgroundCheckStatusBadge: View {
  private let status: BackgroundCheckStatus

  public init(status: BackgroundCheckStatus) {
    self.status = status
  }

  public var body: some View {
    DankBadge(status.displayLabel, tone: Self.tone(for: status))
      .accessibilityLabel("Background check status: \(status.displayLabel)")
  }

  public static func tone(for status: BackgroundCheckStatus) -> DankBadge.Tone {
    switch status {
    case .notStarted: .neutral
    case .inReview: .warning
    case .passed: .success
    }
  }
}

#Preview {
  VStack(spacing: DankSpacing.sm) {
    ForEach(BackgroundCheckStatus.allCases, id: \.self) { status in
      BackgroundCheckStatusBadge(status: status)
    }
  }
  .padding()
  .background(DankColor.cream)
}
