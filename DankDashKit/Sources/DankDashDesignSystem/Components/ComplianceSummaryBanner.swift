import SwiftUI
import DankDashDomain

/// Three-bar compliance preview banner. Reads from a
/// ``ComplianceEvaluation`` and renders the flower / concentrate /
/// edible-THC progress side by side, with a caption summarizing the
/// overall pass / fail decision.
///
/// `passed == true` → calm green caption; failed → a red banner explains
/// which rule blocked. The banner doesn't surface every failed rule —
/// only `per_transaction_limit` is over-shoppable; geofence / hours
/// failures are surfaced by the parent feature as their own explanation
/// cards above the cart.
public struct ComplianceSummaryBanner: View {
  private let evaluation: ComplianceEvaluation

  public init(evaluation: ComplianceEvaluation) {
    self.evaluation = evaluation
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: DankSpacing.sm) {
      headerRow
      bars
      if let overLimitMessage {
        DankBadge(overLimitMessage, tone: .danger)
      }
    }
    .padding(DankSpacing.md)
    .background(
      RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous)
        .fill(DankColor.primary.opacity(0.04))
    )
    .overlay(
      RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous)
        .strokeBorder(borderColor, lineWidth: 1)
    )
    .accessibilityElement(children: .contain)
  }

  private var headerRow: some View {
    HStack(spacing: DankSpacing.xs) {
      Image(systemName: evaluation.passed ? "checkmark.seal.fill" : "exclamationmark.triangle.fill")
        .foregroundStyle(evaluation.passed ? DankColor.Semantic.success : DankColor.Semantic.danger)
        .accessibilityHidden(true)
      Text("Within your daily limits")
        .font(DankFont.headline)
        .foregroundStyle(DankColor.Text.primary)
      Spacer(minLength: 0)
    }
  }

  private var bars: some View {
    VStack(spacing: DankSpacing.sm) {
      ComplianceProgressBar(
        title: "Flower",
        current: evaluation.cartTotals.flowerGrams,
        max: evaluation.limits.flowerGramsMax,
        unit: "g"
      )
      ComplianceProgressBar(
        title: "Concentrate",
        current: evaluation.cartTotals.concentrateGrams,
        max: evaluation.limits.concentrateGramsMax,
        unit: "g"
      )
      ComplianceProgressBar(
        title: "Edible THC",
        current: evaluation.cartTotals.edibleThcMg,
        max: evaluation.limits.edibleThcMgMax,
        unit: "mg"
      )
    }
  }

  /// We surface a red message only when the failing rule is the
  /// over-the-limit one — the picker can't fix a geofence failure by
  /// adjusting cart quantities. The copy is intentionally generic; the
  /// detailed "X grams over" math reads off `result.details` in the
  /// parent feature for the inline blocking banner.
  private var overLimitMessage: String? {
    guard let rule = evaluation.result(for: .perTransactionLimit) else { return nil }
    return rule.passed ? nil : "Cart exceeds daily limits"
  }

  private var borderColor: Color {
    evaluation.passed
      ? DankColor.Semantic.success.opacity(0.4)
      : DankColor.Semantic.danger.opacity(0.55)
  }
}

#Preview {
  let evaluation = ComplianceEvaluation(
    passed: true,
    rules: [],
    cartTotals: ComplianceTotals(
      flowerGrams: Decimal(string: "12.3")!,
      concentrateGrams: Decimal(string: "0.5")!,
      edibleThcMg: Decimal(string: "150")!
    ),
    limits: ComplianceLimits(
      flowerGramsMax: Decimal(string: "56.7")!,
      concentrateGramsMax: Decimal(string: "8")!,
      edibleThcMgMax: Decimal(string: "800")!
    ),
    evaluatedAt: Date(),
    evaluationVersion: "1.0.0"
  )
  return ComplianceSummaryBanner(evaluation: evaluation)
    .padding()
    .background(DankColor.cream)
}
