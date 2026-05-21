import Foundation

/// A single lab assay attached to a product. Lab results are sorted
/// newest-first server-side so the detail screen can pluck index `0`
/// without re-sorting.
public struct LabResult: Identifiable, Hashable, Sendable, Codable {
  public let id: UUID
  public let batchId: String
  public let labName: String
  public let coaDocumentKey: String?
  public let potencyThc: Decimal?
  public let potencyCbd: Decimal?
  public let contaminantsPassed: Bool?
  /// Calendar date the assay ran, ISO `YYYY-MM-DD`. Kept as a String
  /// because the display always renders the date verbatim — never the
  /// rendered instant — so a date-formatter pass would only introduce
  /// rounding bugs around timezone math.
  public let testedAt: String

  public init(
    id: UUID,
    batchId: String,
    labName: String,
    coaDocumentKey: String?,
    potencyThc: Decimal?,
    potencyCbd: Decimal?,
    contaminantsPassed: Bool?,
    testedAt: String
  ) {
    self.id = id
    self.batchId = batchId
    self.labName = labName
    self.coaDocumentKey = coaDocumentKey
    self.potencyThc = potencyThc
    self.potencyCbd = potencyCbd
    self.contaminantsPassed = contaminantsPassed
    self.testedAt = testedAt
  }
}
