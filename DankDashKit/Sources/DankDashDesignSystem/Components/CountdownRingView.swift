import SwiftUI

/// Circular countdown ring used in the dispatch-offer card. Renders a
/// 30s arc that drains from full to empty as the offer expires; the
/// stroke tint walks from `primary` (plenty of time) through
/// `Semantic.warning` (closing window) to `Semantic.danger` (about to
/// expire). The center renders the integer seconds remaining as the
/// big-number label.
///
/// The ring takes a `secondsRemaining` + `totalSeconds` pair rather
/// than computing its own clock so the reducer drives the animation
/// (matches the existing TestStore-friendly TCA conventions in the
/// project — no view-side timers).
public struct CountdownRingView: View {
  private let secondsRemaining: TimeInterval
  private let totalSeconds: TimeInterval
  private let diameter: CGFloat
  private let strokeWidth: CGFloat

  public init(
    secondsRemaining: TimeInterval,
    totalSeconds: TimeInterval,
    diameter: CGFloat = 84,
    strokeWidth: CGFloat = 8
  ) {
    self.secondsRemaining = max(0, secondsRemaining)
    self.totalSeconds = max(0.001, totalSeconds)
    self.diameter = diameter
    self.strokeWidth = strokeWidth
  }

  public var body: some View {
    ZStack {
      Circle()
        .stroke(DankColor.Text.muted.opacity(0.18), lineWidth: strokeWidth)
      Circle()
        .trim(from: 0, to: progress)
        .stroke(
          tint,
          style: StrokeStyle(lineWidth: strokeWidth, lineCap: .round)
        )
        .rotationEffect(.degrees(-90))
        .animation(.linear(duration: 0.25), value: progress)
      VStack(spacing: 0) {
        Text(label)
          .font(.system(size: diameter * 0.34, weight: .semibold, design: .rounded))
          .foregroundStyle(tint)
          .monospacedDigit()
        Text("sec")
          .font(.system(size: diameter * 0.12, weight: .medium))
          .foregroundStyle(DankColor.Text.muted)
      }
    }
    .frame(width: diameter, height: diameter)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityLabel)
  }

  /// `0.0...1.0` — fraction of the window still available. Clamped both
  /// ends so an expired offer reads as an empty ring without animation
  /// glitches.
  public var progress: CGFloat {
    CGFloat(max(0, min(1, secondsRemaining / totalSeconds)))
  }

  /// Integer seconds for the center label. Rounds UP so `0.4s` still
  /// reads as "1" to the driver — the offer is technically alive until
  /// the reducer flips it to expired, and a "0" mid-animation feels
  /// wrong.
  public var label: String {
    String(Int(ceil(secondsRemaining)))
  }

  /// Tint walks across three brand semantic tones:
  ///
  ///   - `progress >= 0.5` — `primary` (plenty of time)
  ///   - `progress >= 0.2` — `Semantic.warning` (closing window)
  ///   - `progress  < 0.2` — `Semantic.danger` (urgent)
  ///
  /// Animation interpolation between colors is handled by SwiftUI's
  /// implicit transition on stroke style.
  public var tint: Color {
    if progress >= 0.5 { return DankColor.primary }
    if progress >= 0.2 { return DankColor.Semantic.warning }
    return DankColor.Semantic.danger
  }

  private var accessibilityLabel: String {
    let secs = Int(ceil(secondsRemaining))
    if secs <= 0 { return "Offer expired" }
    if secs == 1 { return "1 second remaining" }
    return "\(secs) seconds remaining"
  }
}

#Preview {
  HStack(spacing: DankSpacing.lg) {
    CountdownRingView(secondsRemaining: 30, totalSeconds: 30)
    CountdownRingView(secondsRemaining: 18, totalSeconds: 30)
    CountdownRingView(secondsRemaining: 4, totalSeconds: 30)
  }
  .padding()
  .background(DankColor.background)
}
