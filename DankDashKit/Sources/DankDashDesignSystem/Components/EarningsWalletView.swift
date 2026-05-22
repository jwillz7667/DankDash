import SwiftUI
import DankDashDomain

/// Full-page earnings wallet — replaces Phase 19's `EarningsView`
/// wiring. Renders the period segmented control, the headline payout +
/// tip / delivery-fee breakdown, the recent-cashouts list, and the
/// cashout CTA.
///
/// The view is a pure projection of ``DriverEarnings`` +
/// `[CashoutRequest]`. State changes (period switch, pull-to-refresh,
/// cashout sheet open) all flow back through the closures so the
/// parent reducer stays the source of truth.
public struct EarningsWalletView: View {
  private let period: EarningsPeriod
  private let earnings: DriverEarnings?
  private let recentCashouts: [CashoutRequest]
  private let isLoading: Bool
  private let cashoutCTAEnabled: Bool
  private let onPeriodChanged: (EarningsPeriod) -> Void
  private let onCashoutTapped: () -> Void

  public init(
    period: EarningsPeriod,
    earnings: DriverEarnings?,
    recentCashouts: [CashoutRequest],
    isLoading: Bool,
    cashoutCTAEnabled: Bool,
    onPeriodChanged: @escaping (EarningsPeriod) -> Void,
    onCashoutTapped: @escaping () -> Void
  ) {
    self.period = period
    self.earnings = earnings
    self.recentCashouts = recentCashouts
    self.isLoading = isLoading
    self.cashoutCTAEnabled = cashoutCTAEnabled
    self.onPeriodChanged = onPeriodChanged
    self.onCashoutTapped = onCashoutTapped
  }

  public var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(alignment: .leading, spacing: DankSpacing.lg) {
          periodPicker
          headlineCard
          breakdownCard
          recentCashoutsSection
        }
        .padding(DankSpacing.lg)
      }
      cashoutCTA
    }
    .background(DankColor.background)
  }

  // MARK: - Period picker

  private var periodPicker: some View {
    Picker("Period", selection: Binding(
      get: { period },
      set: { onPeriodChanged($0) }
    )) {
      ForEach(EarningsPeriod.allCases, id: \.self) { period in
        Text(Self.label(for: period)).tag(period)
      }
    }
    .pickerStyle(.segmented)
    .accessibilityLabel("Earnings period")
  }

  public static func label(for period: EarningsPeriod) -> String {
    switch period {
    case .today: "Today"
    case .week: "Week"
    case .month: "Month"
    }
  }

  // MARK: - Headline

  private var headlineCard: some View {
    VStack(alignment: .leading, spacing: DankSpacing.xs) {
      Text(Self.label(for: period))
        .font(DankFont.caption)
        .foregroundStyle(DankColor.Text.muted)
        .textCase(.uppercase)
      Text(Self.formatPrice(earnings?.totalCents ?? 0))
        .font(DankFont.display)
        .foregroundStyle(DankColor.Text.onBackground)
        .accessibilityLabel("Total earnings \(Self.formatPrice(earnings?.totalCents ?? 0))")
      Text(deliveriesLabel)
        .font(DankFont.body)
        .foregroundStyle(DankColor.Text.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(DankSpacing.lg)
    .background(DankColor.primary.opacity(0.06))
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous))
  }

  public var deliveriesLabel: String {
    Self.deliveriesLabel(deliveries: earnings?.deliveriesCount ?? 0)
  }

  public static func deliveriesLabel(deliveries: Int) -> String {
    deliveries == 1 ? "1 delivery" : "\(deliveries) deliveries"
  }

  // MARK: - Breakdown

  private var breakdownCard: some View {
    VStack(alignment: .leading, spacing: DankSpacing.sm) {
      Text("Breakdown")
        .font(DankFont.caption)
        .foregroundStyle(DankColor.Text.muted)
        .textCase(.uppercase)
      breakdownRow(
        label: "Delivery fees",
        cents: earnings?.deliveryFeesCents ?? 0
      )
      Divider().background(DankColor.Text.muted.opacity(0.15))
      breakdownRow(
        label: "Tips",
        cents: earnings?.tipsCents ?? 0
      )
      Divider().background(DankColor.Text.muted.opacity(0.15))
      breakdownRow(
        label: "Total",
        cents: earnings?.totalCents ?? 0,
        emphasis: true
      )
    }
    .padding(DankSpacing.lg)
    .background(DankColor.background)
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: DankRadius.lg, style: .continuous)
        .strokeBorder(DankColor.primary.opacity(0.12), lineWidth: 1)
    )
  }

  private func breakdownRow(label: String, cents: Int, emphasis: Bool = false) -> some View {
    HStack {
      Text(label)
        .font(emphasis ? DankFont.headline : DankFont.body)
        .foregroundStyle(DankColor.Text.onBackground)
      Spacer()
      Text(Self.formatPrice(cents))
        .font(emphasis ? DankFont.headline : DankFont.body)
        .foregroundStyle(DankColor.Text.onBackground)
        .monospacedDigit()
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(label) \(Self.formatPrice(cents))")
  }

  // MARK: - Recent cashouts

  @ViewBuilder private var recentCashoutsSection: some View {
    if recentCashouts.isEmpty {
      EmptyView()
    } else {
      VStack(alignment: .leading, spacing: DankSpacing.sm) {
        Text("Recent cashouts")
          .font(DankFont.caption)
          .foregroundStyle(DankColor.Text.muted)
          .textCase(.uppercase)
        ForEach(recentCashouts) { cashout in
          cashoutRow(cashout)
        }
      }
    }
  }

  private func cashoutRow(_ cashout: CashoutRequest) -> some View {
    HStack(spacing: DankSpacing.sm) {
      Image(systemName: "arrow.up.right.circle.fill")
        .font(DankFont.headline)
        .foregroundStyle(DankColor.primary)
      VStack(alignment: .leading, spacing: 2) {
        Text(Self.formatPrice(cashout.amountCents))
          .font(DankFont.body)
          .foregroundStyle(DankColor.Text.onBackground)
        Text(cashout.status.displayLabel)
          .font(DankFont.caption)
          .foregroundStyle(EarningsWalletView.tint(for: cashout.status))
      }
      Spacer()
      Text(Self.formatDate(cashout.requestedAt))
        .font(DankFont.caption)
        .foregroundStyle(DankColor.Text.muted)
    }
    .padding(DankSpacing.sm)
    .background(DankColor.Text.muted.opacity(0.08))
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
  }

  public static func tint(for status: CashoutStatus) -> Color {
    switch status {
    case .pending, .processing: DankColor.Semantic.info
    case .completed: DankColor.Semantic.success
    case .failed: DankColor.Semantic.danger
    case .canceled: DankColor.Text.muted
    }
  }

  // MARK: - Cashout CTA

  private var cashoutCTA: some View {
    Button(action: onCashoutTapped) {
      Text("Request Cashout")
        .font(DankFont.headline)
        .foregroundStyle(DankColor.Text.onPrimary)
        .frame(maxWidth: .infinity, minHeight: 52)
        .background(cashoutCTAEnabled ? DankColor.primary : DankColor.Text.muted.opacity(0.4))
        .clipShape(Capsule())
    }
    .disabled(!cashoutCTAEnabled || isLoading)
    .padding(DankSpacing.lg)
    .accessibilityLabel("Request cashout to Aeropay")
  }

  // MARK: - Formatters

  public static func formatPrice(_ cents: Int) -> String {
    let dollars = Decimal(cents) / 100
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.locale = Locale(identifier: "en_US")
    return formatter.string(from: dollars as NSDecimalNumber) ?? "$0.00"
  }

  public static func formatDate(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.dateStyle = .medium
    formatter.timeStyle = .none
    formatter.locale = Locale(identifier: "en_US")
    return formatter.string(from: date)
  }
}

#Preview {
  EarningsWalletView(
    period: .today,
    earnings: DriverEarnings(
      period: .today,
      since: Date().addingTimeInterval(-86_400),
      until: Date(),
      tipsCents: 4_850,
      deliveryFeesCents: 9_500,
      deliveriesCount: 7,
      totalCents: 14_350
    ),
    recentCashouts: [
      CashoutRequest(
        id: UUID(),
        amountCents: 5_000,
        status: .completed,
        requestedAt: Date().addingTimeInterval(-7 * 86_400),
        aeropayPayoutRef: "AP-123"
      )
    ],
    isLoading: false,
    cashoutCTAEnabled: true,
    onPeriodChanged: { _ in },
    onCashoutTapped: {}
  )
}
