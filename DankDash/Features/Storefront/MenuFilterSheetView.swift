import SwiftUI
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// Bottom sheet with the menu's filter facets — strain type chips, a
/// price range slider, a THC range slider, and a multi-select chip rail
/// of effects. The sheet drives a `MenuFilter` binding the storefront
/// reducer owns; "Clear" resets to `.none`, "Done" dismisses.
struct MenuFilterSheetView: View {
  @Binding var filter: MenuFilter
  let onCleared: () -> Void
  let onDismiss: () -> Void

  /// Static effect chips lifted from common product effect tags. The
  /// dispensary menu doesn't expose a master effects vocabulary today,
  /// so this list is the working set; future iterations will compute it
  /// from menuItems on the parent.
  private let availableEffects: [String] = [
    "Relaxed", "Uplifted", "Focused", "Sleepy", "Creative", "Energetic", "Hungry", "Happy",
  ]

  private let priceBoundsCents = 0...20_000
  private let thcBounds: ClosedRange<Double> = 0...500

  @State private var priceLowerCents: Double = 0
  @State private var priceUpperCents: Double = 20_000
  @State private var thcLower: Double = 0
  @State private var thcUpper: Double = 500

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: DankSpacing.lg) {
          section("Strain type") {
            FlowChipRow(
              items: StrainType.allCases.map { strain in
                ChipDescriptor(
                  id: strain.rawValue,
                  title: strain.rawValue.capitalized,
                  isSelected: filter.strainTypes.contains(strain),
                  action: {
                    var next = filter.strainTypes
                    if next.contains(strain) { next.remove(strain) } else { next.insert(strain) }
                    filter.strainTypes = next
                  }
                )
              }
            )
          }

          section("Price range") {
            VStack(alignment: .leading, spacing: DankSpacing.xs) {
              Text("\(currency(Int(priceLowerCents))) – \(currency(Int(priceUpperCents)))")
                .font(DankFont.body.weight(.semibold))
                .foregroundStyle(DankColor.Text.primary)
              RangeSlider(
                lower: $priceLowerCents,
                upper: $priceUpperCents,
                bounds: Double(priceBoundsCents.lowerBound)...Double(priceBoundsCents.upperBound),
                step: 500
              )
              .onChange(of: priceLowerCents) { _, _ in syncPriceRange() }
              .onChange(of: priceUpperCents) { _, _ in syncPriceRange() }
            }
          }

          section("THC per unit") {
            VStack(alignment: .leading, spacing: DankSpacing.xs) {
              Text("\(Int(thcLower.rounded())) – \(Int(thcUpper.rounded())) mg")
                .font(DankFont.body.weight(.semibold))
                .foregroundStyle(DankColor.Text.primary)
              RangeSlider(
                lower: $thcLower,
                upper: $thcUpper,
                bounds: thcBounds,
                step: 5
              )
              .onChange(of: thcLower) { _, _ in syncThcRange() }
              .onChange(of: thcUpper) { _, _ in syncThcRange() }
            }
          }

          section("Effects") {
            FlowChipRow(
              items: availableEffects.map { effect in
                ChipDescriptor(
                  id: effect,
                  title: effect,
                  isSelected: filter.effects.contains(effect),
                  action: {
                    var next = filter.effects
                    if next.contains(effect) { next.remove(effect) } else { next.insert(effect) }
                    filter.effects = next
                  }
                )
              }
            )
          }
        }
        .padding(DankSpacing.lg)
      }
      .background(DankColor.cream.ignoresSafeArea())
      .navigationTitle("Filters")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Clear") {
            priceLowerCents = Double(priceBoundsCents.lowerBound)
            priceUpperCents = Double(priceBoundsCents.upperBound)
            thcLower = thcBounds.lowerBound
            thcUpper = thcBounds.upperBound
            onCleared()
          }
          .foregroundStyle(DankColor.primary)
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button("Done", action: onDismiss)
            .font(DankFont.body.weight(.semibold))
            .foregroundStyle(DankColor.primary)
        }
      }
      .onAppear {
        priceLowerCents = filter.priceRangeCents.map { Double($0.lowerBound) } ?? Double(priceBoundsCents.lowerBound)
        priceUpperCents = filter.priceRangeCents.map { Double($0.upperBound) } ?? Double(priceBoundsCents.upperBound)
        thcLower = filter.thcMgRange.map { NSDecimalNumber(decimal: $0.lowerBound).doubleValue } ?? thcBounds.lowerBound
        thcUpper = filter.thcMgRange.map { NSDecimalNumber(decimal: $0.upperBound).doubleValue } ?? thcBounds.upperBound
      }
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
  }

  private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: DankSpacing.sm) {
      Text(title.uppercased())
        .font(DankFont.caption)
        .tracking(1.2)
        .foregroundStyle(DankColor.Text.secondary)
      content()
    }
  }

  private func syncPriceRange() {
    if priceLowerCents == Double(priceBoundsCents.lowerBound)
       && priceUpperCents == Double(priceBoundsCents.upperBound) {
      filter.priceRangeCents = nil
    } else {
      filter.priceRangeCents = Int(priceLowerCents)...Int(priceUpperCents)
    }
  }

  private func syncThcRange() {
    if thcLower == thcBounds.lowerBound && thcUpper == thcBounds.upperBound {
      filter.thcMgRange = nil
    } else {
      filter.thcMgRange = Decimal(Int(thcLower.rounded()))...Decimal(Int(thcUpper.rounded()))
    }
  }

  private func currency(_ cents: Int) -> String {
    let dollars = Double(cents) / 100
    let f = NumberFormatter()
    f.numberStyle = .currency
    f.currencyCode = "USD"
    f.maximumFractionDigits = 0
    return f.string(from: NSNumber(value: dollars)) ?? "$\(Int(dollars))"
  }
}

private struct ChipDescriptor: Identifiable {
  let id: String
  let title: String
  let isSelected: Bool
  let action: () -> Void
}

/// Flow-laid chip rail. SwiftUI doesn't have a flow layout primitive on
/// the iOS deployment target; this lays out via a Layout subclass so
/// chips wrap when they overflow the row.
private struct FlowChipRow: View {
  let items: [ChipDescriptor]

  var body: some View {
    FlowLayout(spacing: DankSpacing.xs) {
      ForEach(items) { item in
        FacetPill(title: item.title, isSelected: item.isSelected, action: item.action)
      }
    }
  }
}

private struct FlowLayout: Layout {
  let spacing: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let maxWidth = proposal.width ?? .infinity
    var currentRowWidth: CGFloat = 0
    var totalHeight: CGFloat = 0
    var rowHeight: CGFloat = 0
    var totalWidth: CGFloat = 0

    for subview in subviews {
      let size = subview.sizeThatFits(.unspecified)
      if currentRowWidth + size.width > maxWidth, currentRowWidth > 0 {
        totalHeight += rowHeight + spacing
        totalWidth = max(totalWidth, currentRowWidth - spacing)
        currentRowWidth = 0
        rowHeight = 0
      }
      currentRowWidth += size.width + spacing
      rowHeight = max(rowHeight, size.height)
    }
    totalHeight += rowHeight
    totalWidth = max(totalWidth, currentRowWidth - spacing)
    return CGSize(width: totalWidth, height: totalHeight)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let maxWidth = bounds.width
    var x: CGFloat = bounds.minX
    var y: CGFloat = bounds.minY
    var rowHeight: CGFloat = 0

    for subview in subviews {
      let size = subview.sizeThatFits(.unspecified)
      if x + size.width > bounds.minX + maxWidth, x > bounds.minX {
        x = bounds.minX
        y += rowHeight + spacing
        rowHeight = 0
      }
      subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
      x += size.width + spacing
      rowHeight = max(rowHeight, size.height)
    }
  }
}

/// Two-thumb range slider built from a single composition because
/// SwiftUI's `Slider` only supports a single value out of the box. Visual
/// design is kept minimal: a primary track between the thumbs and a
/// neutral track outside them.
private struct RangeSlider: View {
  @Binding var lower: Double
  @Binding var upper: Double
  let bounds: ClosedRange<Double>
  let step: Double

  var body: some View {
    GeometryReader { proxy in
      let width = proxy.size.width
      let lowerRatio = ratio(for: lower)
      let upperRatio = ratio(for: upper)

      ZStack(alignment: .leading) {
        RoundedRectangle(cornerRadius: 999)
          .fill(DankColor.primary.opacity(0.12))
          .frame(height: 4)
        RoundedRectangle(cornerRadius: 999)
          .fill(DankColor.primary)
          .frame(width: max(0, (upperRatio - lowerRatio) * width), height: 4)
          .offset(x: lowerRatio * width)

        thumb
          .offset(x: lowerRatio * width - 12)
          .gesture(dragGesture(width: width, isLower: true))
        thumb
          .offset(x: upperRatio * width - 12)
          .gesture(dragGesture(width: width, isLower: false))
      }
      .frame(height: 28)
    }
    .frame(height: 28)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Range slider")
    .accessibilityValue("From \(Int(lower)) to \(Int(upper))")
  }

  private var thumb: some View {
    Circle()
      .fill(DankColor.cream)
      .frame(width: 24, height: 24)
      .overlay(Circle().strokeBorder(DankColor.primary, lineWidth: 2))
      .shadow(color: DankColor.primaryDark.opacity(0.18), radius: 4, y: 2)
  }

  private func ratio(for value: Double) -> Double {
    let span = bounds.upperBound - bounds.lowerBound
    guard span > 0 else { return 0 }
    return (value - bounds.lowerBound) / span
  }

  private func dragGesture(width: CGFloat, isLower: Bool) -> some Gesture {
    DragGesture(minimumDistance: 0)
      .onChanged { drag in
        let clamped = max(0, min(width, drag.location.x))
        let span = bounds.upperBound - bounds.lowerBound
        let raw = bounds.lowerBound + Double(clamped / width) * span
        let snapped = (raw / step).rounded() * step
        let bounded = min(bounds.upperBound, max(bounds.lowerBound, snapped))
        if isLower {
          lower = min(bounded, upper)
        } else {
          upper = max(bounded, lower)
        }
      }
  }
}
