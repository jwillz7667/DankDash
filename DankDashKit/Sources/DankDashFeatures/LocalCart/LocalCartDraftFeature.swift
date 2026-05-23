import Foundation
import ComposableArchitecture
import DankDashDomain

/// In-memory cart draft reducer. Owned by the Browse parent so the
/// product-detail "Add to cart" button and the Cart tab share one
/// source of truth. Phase 18 promotes this draft to a real
/// server-side cart and hands checkout off to Safari per Apple §10.4;
/// for Phase 17 it is the entire cart surface.
///
/// All quantity clamping lives in `Domain.LocalCartDraft.add` /
/// `setQuantity` — the reducer is just an action surface around the
/// pure value type.
@Reducer
public struct LocalCartDraftFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable {
    public var draft: LocalCartDraft

    public init(draft: LocalCartDraft = LocalCartDraft()) {
      self.draft = draft
    }

    public var isEmpty: Bool { draft.isEmpty }
    public var totalQuantity: Int { draft.totalQuantity }
    public var totalCents: Int { draft.totalCents }
    public var lines: [LocalCartDraft.Line] { draft.lines }
  }

  public enum Action: Sendable, Equatable {
    /// Append one unit of the addressed listing. If the listing is
    /// already in the draft its quantity is bumped (clamped to
    /// `maxAvailable`). Sold-out listings (`maxAvailable <= 0`) are
    /// rejected without mutation.
    case addLine(
      listingId: UUID,
      productId: UUID,
      productName: String,
      brand: String,
      priceCents: Int,
      maxAvailable: Int
    )
    /// Set the absolute quantity on a line. <= 0 removes the line.
    case setQuantity(listingId: UUID, quantity: Int)
    case removeLine(listingId: UUID)
    case clearAll
  }

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .addLine(
        let listingId,
        let productId,
        let productName,
        let brand,
        let priceCents,
        let maxAvailable
      ):
        guard maxAvailable > 0 else { return .none }
        state.draft.add(
          LocalCartDraft.Line(
            listingId: listingId,
            productId: productId,
            productName: productName,
            brand: brand,
            priceCents: priceCents,
            quantity: 1,
            maxAvailable: maxAvailable
          )
        )
        return .none

      case .setQuantity(let listingId, let quantity):
        state.draft.setQuantity(quantity, for: listingId)
        return .none

      case .removeLine(let listingId):
        state.draft.remove(listingId: listingId)
        return .none

      case .clearAll:
        state.draft.clear()
        return .none
      }
    }
  }
}
