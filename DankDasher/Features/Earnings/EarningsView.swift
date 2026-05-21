import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// Full-page earnings surface pushed from the shift home's earnings
/// card. The segmented control switches between
/// ``EarningsPeriod/today`` / `.week` / `.month`; each change refetches
/// both endpoints concurrently. Pull-to-refresh fires
/// ``DriverEarningsFeature/Action/pullToRefresh``.
///
/// The screen renders three regions stacked top to bottom:
///
/// 1. Period control + the big totals card (`$XX.YY total`, deliveries,
///    tips, delivery-fee breakdown).
/// 2. A shift-history list — each row shows the shift's start/end time,
///    miles, deliveries, and total earnings.
/// 3. Error banner (dismissible) when a fetch fails for a real network
///    reason. 404s are absorbed silently per the read-only contract.
struct EarningsView: View {
  @Bindable var store: StoreOf<DriverEarningsFeature>
  let onDismiss: () -> Void

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: DankSpacing.lg) {
          if let banner = store.errorBanner {
            errorBanner(banner)
          }

          periodPicker

          totalsCard

          shiftHistorySection
        }
        .padding(DankSpacing.lg)
        .frame(maxWidth: 560)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      .background(DankColor.cream)
      .refreshable {
        store.send(.pullToRefresh)
        // Hold the spinner until both fetches settle.
        await waitForRefreshCompletion()
      }
      .navigationTitle("Earnings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Back to shift", action: onDismiss)
        }
      }
      .task { store.send(.onAppear) }
    }
  }

  // MARK: - Period picker

  private var periodPicker: some View {
    Picker("Period", selection: Binding(
      get: { store.period },
      set: { store.send(.periodChanged($0)) }
    )) {
      ForEach(EarningsPeriod.allCases, id: \.self) { period in
        Text(periodLabel(period)).tag(period)
      }
    }
    .pickerStyle(.segmented)
    .accessibilityIdentifier("earnings.periodPicker")
  }

  // MARK: - Totals card

  @ViewBuilder
  private var totalsCard: some View {
    if store.isInitialLoading {
      DankCard {
        VStack(spacing: DankSpacing.md) {
          ProgressView().controlSize(.large)
          Text("Loading earnings…")
            .font(DankFont.body)
            .foregroundStyle(DankColor.Text.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, DankSpacing.lg)
      }
    } else if let earnings = store.earnings {
      DankCard {
        VStack(alignment: .leading, spacing: DankSpacing.md) {
          VStack(alignment: .leading, spacing: DankSpacing.xxs) {
            Text(periodHeadline(earnings.period))
              .font(DankFont.caption)
              .foregroundStyle(DankColor.Text.muted)
            Text(formatPrice(earnings.totalCents))
              .font(DankFont.display)
              .foregroundStyle(DankColor.Text.primary)
              .accessibilityIdentifier("earnings.totalLabel")
            Text(dateRangeLabel(since: earnings.since, until: earnings.until))
              .font(DankFont.caption)
              .foregroundStyle(DankColor.Text.muted)
          }

          Divider().background(DankColor.primary.opacity(0.12))

          VStack(spacing: DankSpacing.sm) {
            breakdownRow(
              label: "Deliveries",
              value: "\(earnings.deliveriesCount)"
            )
            breakdownRow(
              label: "Delivery fees",
              value: formatPrice(earnings.deliveryFeesCents)
            )
            breakdownRow(
              label: "Tips",
              value: formatPrice(earnings.tipsCents)
            )
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    } else {
      DankCard {
        VStack(spacing: DankSpacing.sm) {
          Image(systemName: "tray")
            .font(.system(size: 36, weight: .regular))
            .foregroundStyle(DankColor.Text.muted)
            .accessibilityHidden(true)
          Text("No earnings yet")
            .font(DankFont.headline)
            .foregroundStyle(DankColor.Text.primary)
          Text("Once you complete a delivery in this window your totals will appear here.")
            .font(DankFont.bodySmall)
            .foregroundStyle(DankColor.Text.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, DankSpacing.sm)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, DankSpacing.md)
      }
    }
  }

  // MARK: - Shift history

  @ViewBuilder
  private var shiftHistorySection: some View {
    VStack(alignment: .leading, spacing: DankSpacing.sm) {
      Text("Recent shifts")
        .font(DankFont.headline)
        .foregroundStyle(DankColor.Text.primary)

      if store.isLoadingShifts && store.shifts.isEmpty {
        DankCard {
          HStack {
            Spacer(minLength: 0)
            ProgressView()
            Spacer(minLength: 0)
          }
          .padding(.vertical, DankSpacing.md)
        }
      } else if store.shifts.isEmpty {
        DankCard {
          VStack(spacing: DankSpacing.xs) {
            Text("No shifts yet")
              .font(DankFont.body)
              .foregroundStyle(DankColor.Text.primary)
            Text("Your closed shifts will show up here.")
              .font(DankFont.caption)
              .foregroundStyle(DankColor.Text.secondary)
              .multilineTextAlignment(.center)
          }
          .frame(maxWidth: .infinity)
          .padding(.vertical, DankSpacing.md)
        }
      } else {
        VStack(spacing: DankSpacing.sm) {
          ForEach(store.shifts, id: \.id) { shift in
            Button {
              store.send(.shiftRowTapped(shift.id))
            } label: {
              shiftRow(shift)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("earnings.shiftRow.\(shift.id.uuidString)")
          }
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder
  private func shiftRow(_ shift: DriverShift) -> some View {
    DankCard {
      HStack(alignment: .center, spacing: DankSpacing.md) {
        VStack(alignment: .leading, spacing: DankSpacing.xxs) {
          Text(shiftDateLabel(shift))
            .font(DankFont.body)
            .foregroundStyle(DankColor.Text.primary)
          Text(shiftMetadataLabel(shift))
            .font(DankFont.caption)
            .foregroundStyle(DankColor.Text.secondary)
        }
        Spacer(minLength: 0)
        VStack(alignment: .trailing, spacing: DankSpacing.xxs) {
          Text(formatPrice(shift.totalEarningsCents))
            .font(DankFont.headline)
            .foregroundStyle(DankColor.Text.primary)
          Image(systemName: "chevron.right")
            .font(DankFont.caption)
            .foregroundStyle(DankColor.Text.muted)
            .accessibilityHidden(true)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  // MARK: - Helpers

  @ViewBuilder
  private func breakdownRow(label: String, value: String) -> some View {
    HStack {
      Text(label)
        .font(DankFont.body)
        .foregroundStyle(DankColor.Text.secondary)
      Spacer(minLength: 0)
      Text(value)
        .font(DankFont.body)
        .foregroundStyle(DankColor.Text.primary)
    }
  }

  private func errorBanner(_ message: String) -> some View {
    HStack(alignment: .top, spacing: DankSpacing.sm) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(DankColor.Semantic.danger)
        .accessibilityHidden(true)
      Text(message)
        .font(DankFont.bodySmall)
        .foregroundStyle(DankColor.Text.primary)
      Spacer(minLength: 0)
      Button {
        store.send(.errorBannerDismissed)
      } label: {
        Image(systemName: "xmark")
          .font(DankFont.caption)
          .foregroundStyle(DankColor.Text.muted)
      }
      .accessibilityLabel("Dismiss")
    }
    .padding(DankSpacing.sm)
    .background(DankColor.Semantic.danger.opacity(0.08))
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Error: \(message)")
    .accessibilityIdentifier("earnings.errorBanner")
  }

  private func periodLabel(_ period: EarningsPeriod) -> String {
    switch period {
    case .today: "Today"
    case .week: "Week"
    case .month: "Month"
    }
  }

  private func periodHeadline(_ period: EarningsPeriod) -> String {
    switch period {
    case .today: "TODAY"
    case .week: "THIS WEEK"
    case .month: "THIS MONTH"
    }
  }

  private func dateRangeLabel(since: Date, until: Date) -> String {
    let formatter = DateFormatter()
    formatter.dateStyle = .medium
    formatter.timeStyle = .none
    let calendar = Calendar.current
    if calendar.isDate(since, inSameDayAs: until) {
      return formatter.string(from: since)
    }
    return "\(formatter.string(from: since)) – \(formatter.string(from: until))"
  }

  private func shiftDateLabel(_ shift: DriverShift) -> String {
    let formatter = DateFormatter()
    formatter.dateStyle = .medium
    formatter.timeStyle = .short
    let start = formatter.string(from: shift.startedAt)
    guard let end = shift.endedAt else { return "\(start) — in progress" }
    let timeOnly = DateFormatter()
    timeOnly.dateStyle = .none
    timeOnly.timeStyle = .short
    return "\(start) → \(timeOnly.string(from: end))"
  }

  private func shiftMetadataLabel(_ shift: DriverShift) -> String {
    var parts: [String] = []
    let deliveryCopy = shift.totalDeliveries == 1
      ? "1 delivery"
      : "\(shift.totalDeliveries) deliveries"
    parts.append(deliveryCopy)
    if let miles = shift.totalMiles {
      let mileFormatter = NumberFormatter()
      mileFormatter.numberStyle = .decimal
      mileFormatter.maximumFractionDigits = 1
      mileFormatter.minimumFractionDigits = 1
      if let formatted = mileFormatter.string(from: miles as NSDecimalNumber) {
        parts.append("\(formatted) mi")
      }
    }
    return parts.joined(separator: " · ")
  }

  private func formatPrice(_ cents: Int) -> String {
    let dollars = Decimal(cents) / 100
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.locale = Locale(identifier: "en_US")
    return formatter.string(from: dollars as NSDecimalNumber) ?? "$0.00"
  }

  /// Awaits the reducer's `isRefreshing` flag flipping back to false so
  /// SwiftUI's pull-to-refresh spinner stays up until both concurrent
  /// fetches land. Mirrors `OrderHistoryView`'s spin-wait idiom.
  private func waitForRefreshCompletion() async {
    while store.isRefreshing {
      try? await Task.sleep(nanoseconds: 50_000_000)
    }
  }
}
