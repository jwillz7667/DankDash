import SwiftUI
import DankDashDomain

/// Single row in the driver onboarding documents step. Surfaces one
/// ``DocumentSlot`` with its label, helper copy, current upload state,
/// and a chevron the user taps to open the picker. The row is tappable
/// across its full width.
///
/// State pill mapping:
/// - `.empty` — muted "Add" pill, default for a slot the user hasn't
///   touched yet
/// - `.uploaded` — success "Uploaded" pill, the file has been copied
///   into the on-disk draft store
/// - `.failed` — danger pill with a short reason string
/// - `.uploading` — info pill with a progress indicator (file is being
///   copied into the sandbox)
public struct DocumentUploadRow: View {
  public enum State: Sendable, Equatable {
    case empty
    case uploading
    case uploaded
    case failed(reason: String)
  }

  private let slot: DocumentSlot
  private let state: State
  private let onTap: () -> Void

  public init(slot: DocumentSlot, state: State, onTap: @escaping () -> Void) {
    self.slot = slot
    self.state = state
    self.onTap = onTap
  }

  public var body: some View {
    Button(action: onTap) {
      HStack(alignment: .center, spacing: DankSpacing.md) {
        Image(systemName: iconName)
          .font(DankFont.headline)
          .foregroundStyle(DankColor.primary)
          .frame(width: 40, height: 40)
          .background(DankColor.primary.opacity(0.10))
          .clipShape(RoundedRectangle(cornerRadius: DankRadius.sm, style: .continuous))
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: DankSpacing.xxs) {
          Text(slot.displayLabel)
            .font(DankFont.body)
            .foregroundStyle(DankColor.Text.primary)
          Text(secondaryLabel)
            .font(DankFont.caption)
            .foregroundStyle(secondaryColor)
            .lineLimit(2)
        }
        Spacer(minLength: DankSpacing.sm)
        statePill
        Image(systemName: "chevron.right")
          .font(DankFont.caption)
          .foregroundStyle(DankColor.Text.muted)
          .accessibilityHidden(true)
      }
      .padding(.vertical, DankSpacing.sm)
      .padding(.horizontal, DankSpacing.md)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(DankColor.cream)
      .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous)
          .strokeBorder(DankColor.primary.opacity(0.18), lineWidth: 1)
      )
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel)
    .accessibilityAddTraits(.isButton)
  }

  @ViewBuilder private var statePill: some View {
    switch state {
    case .empty:
      DankBadge("Add", tone: .neutral)
    case .uploading:
      HStack(spacing: DankSpacing.xxs) {
        ProgressView().progressViewStyle(.circular).scaleEffect(0.7)
        Text("Uploading")
          .font(DankFont.caption)
          .foregroundStyle(.white)
      }
      .padding(.horizontal, DankSpacing.sm)
      .padding(.vertical, DankSpacing.xxs)
      .background(DankColor.Semantic.info)
      .clipShape(Capsule())
    case .uploaded:
      DankBadge("Uploaded", tone: .success)
    case .failed:
      DankBadge("Failed", tone: .danger)
    }
  }

  // MARK: - Derived strings

  public var iconName: String {
    switch slot {
    case .driversLicense: "person.text.rectangle"
    case .vehicleInsurance: "doc.text.fill"
    case .vehicleRegistration: "car.fill"
    }
  }

  public var secondaryLabel: String {
    switch state {
    case .empty, .uploading, .uploaded: slot.helperText
    case .failed(let reason): reason
    }
  }

  private var secondaryColor: Color {
    if case .failed = state {
      return DankColor.Semantic.danger
    }
    return DankColor.Text.secondary
  }

  public var accessibilityLabel: String {
    let stateCopy: String = {
      switch state {
      case .empty: "not uploaded"
      case .uploading: "uploading"
      case .uploaded: "uploaded"
      case .failed(let reason): "upload failed: \(reason)"
      }
    }()
    return "\(slot.displayLabel), \(stateCopy)"
  }
}

#Preview {
  VStack(spacing: DankSpacing.sm) {
    DocumentUploadRow(slot: .driversLicense, state: .empty, onTap: {})
    DocumentUploadRow(slot: .vehicleInsurance, state: .uploading, onTap: {})
    DocumentUploadRow(slot: .vehicleRegistration, state: .uploaded, onTap: {})
    DocumentUploadRow(slot: .driversLicense, state: .failed(reason: "File too large"), onTap: {})
  }
  .padding()
  .background(DankColor.cream)
}
