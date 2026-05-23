import Foundation
import DankDashDomain

/// Pure value type that captures the storefront filter sheet's selection.
/// Reducers thread this into ``StorefrontFeature.State`` and call
/// ``apply(to:)`` to narrow the menu. Defaults are "no filter" — every
/// product passes.
///
/// Ranges are closed because the UI sliders include both endpoints. THC
/// is filtered against `thcMgPerUnit` (the wire field that's always
/// present for any product type — flower mg are pre-computed by the
/// backend from per-gram THC% × weight, so a single field suffices).
public struct MenuFilter: Sendable, Equatable, Hashable {
  public var strainTypes: Set<StrainType>
  public var priceRangeCents: ClosedRange<Int>?
  public var thcMgRange: ClosedRange<Decimal>?
  public var effects: Set<String>

  public init(
    strainTypes: Set<StrainType> = [],
    priceRangeCents: ClosedRange<Int>? = nil,
    thcMgRange: ClosedRange<Decimal>? = nil,
    effects: Set<String> = []
  ) {
    self.strainTypes = strainTypes
    self.priceRangeCents = priceRangeCents
    self.thcMgRange = thcMgRange
    self.effects = effects
  }

  public static let none = MenuFilter()

  /// True when any facet is constrained — the view uses this to badge
  /// the filter button.
  public var isActive: Bool {
    !strainTypes.isEmpty
      || priceRangeCents != nil
      || thcMgRange != nil
      || !effects.isEmpty
  }

  /// Returns the subset of `items` that match every active facet. An
  /// empty `strainTypes`/`effects` set matches all products on that
  /// facet (a constraint of `nil`, not `"none of the above"`).
  public func apply(to items: [MenuItem]) -> [MenuItem] {
    items.filter { item in
      let product = item.product

      if !strainTypes.isEmpty {
        guard let strain = product.strainType,
              strainTypes.contains(strain) else { return false }
      }

      if let priceRange = priceRangeCents,
         !priceRange.contains(item.priceCents) {
        return false
      }

      if let thcRange = thcMgRange,
         !thcRange.contains(product.thcMgPerUnit) {
        return false
      }

      if !effects.isEmpty {
        let intersection = effects.intersection(Set(product.effectsTags))
        if intersection.isEmpty { return false }
      }

      return true
    }
  }
}
