import Foundation

/// Cannabis strain classifications. Distinct from the indica/sativa/hybrid
/// UI filter labels because `.cbd` and `.balanced` are also valid for
/// tincture / edible browse paths.
public enum StrainType: String, Hashable, Sendable, CaseIterable, Codable {
  case indica
  case sativa
  case hybrid
  case cbd
  case balanced
}
