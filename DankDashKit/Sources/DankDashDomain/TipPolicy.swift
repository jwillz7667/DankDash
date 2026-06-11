import Foundation

/// Driver-tip business rules, mirrored from the server's checkout DTO
/// (`apps/api/src/modules/checkout/dto/checkout-request.dto.ts`). Every
/// order is a delivery and the tip is mandatory: $2 floor, $500 cap. The
/// mirror exists for UX preview only — the checkout endpoint re-validates
/// and is authoritative, same pattern as the compliance limits.
public enum TipPolicy {
  /// Minimum tip in cents (`MIN_DRIVER_TIP_CENTS` server-side).
  public static let minimumCents = 200

  /// Maximum tip in cents (`MAX_DRIVER_TIP_CENTS` server-side) — the
  /// fat-finger guard, not a business judgment about generosity.
  public static let maximumCents = 50_000

  /// Preset amounts the cart screen offers as one-tap chips. The first
  /// entry is the floor so the default selection is always valid.
  public static let suggestedCents = [200, 300, 500, 1_000]

  /// Snap an arbitrary amount into the legal range. Used when the user
  /// commits a custom tip so the reducer can never hold an amount the
  /// server would reject.
  public static func clamp(_ cents: Int) -> Int {
    min(max(cents, minimumCents), maximumCents)
  }
}
