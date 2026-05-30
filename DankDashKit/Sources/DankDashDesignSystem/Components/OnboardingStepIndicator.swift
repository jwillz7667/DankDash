import SwiftUI

/// Horizontal dot indicator anchored to the top of every onboarding
/// step. Renders `totalSteps` dots; the dot at `currentStep` (0-indexed)
/// is filled with the brand primary, dots before it are filled with a
/// muted primary, and dots after it are unfilled outlines.
///
/// The driver onboarding flow has four explicit steps —
/// welcome → vehicle → documents → review — followed by the terminal
/// `pending` screen which the indicator does not render against.
public struct OnboardingStepIndicator: View {
  private let currentStep: Int
  private let totalSteps: Int

  public init(currentStep: Int, totalSteps: Int) {
    self.currentStep = currentStep
    self.totalSteps = totalSteps
  }

  public var body: some View {
    HStack(spacing: DankSpacing.xs) {
      ForEach(0..<totalSteps, id: \.self) { index in
        dot(for: index)
      }
    }
    .padding(.vertical, DankSpacing.xs)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Step \(clampedCurrent + 1) of \(totalSteps)")
  }

  @ViewBuilder private func dot(for index: Int) -> some View {
    let status = Self.status(currentStep: clampedCurrent, totalSteps: totalSteps, index: index)
    switch status {
    case .completed:
      Circle()
        .fill(DankColor.primary.opacity(0.45))
        .frame(width: 8, height: 8)
    case .current:
      Capsule()
        .fill(DankColor.primary)
        .frame(width: 28, height: 8)
    case .upcoming:
      Circle()
        .strokeBorder(DankColor.primary.opacity(0.30), lineWidth: 1.5)
        .frame(width: 8, height: 8)
    }
  }

  public enum DotStatus: Sendable, Equatable {
    case completed
    case current
    case upcoming
  }

  public static func status(currentStep: Int, totalSteps: Int, index: Int) -> DotStatus {
    let clampedCurrent = min(max(currentStep, 0), max(totalSteps - 1, 0))
    if index < clampedCurrent {
      return .completed
    } else if index == clampedCurrent {
      return .current
    } else {
      return .upcoming
    }
  }

  public var clampedCurrent: Int {
    min(max(currentStep, 0), max(totalSteps - 1, 0))
  }
}

#Preview {
  VStack(spacing: DankSpacing.md) {
    OnboardingStepIndicator(currentStep: 0, totalSteps: 4)
    OnboardingStepIndicator(currentStep: 1, totalSteps: 4)
    OnboardingStepIndicator(currentStep: 2, totalSteps: 4)
    OnboardingStepIndicator(currentStep: 3, totalSteps: 4)
  }
  .padding()
  .background(DankColor.cream)
}
