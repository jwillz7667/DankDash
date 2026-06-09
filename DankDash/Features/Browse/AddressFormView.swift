import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashFeatures

/// Sheet view bound to ``AddressFormFeature`` — the add/edit address form
/// reached from the Account tab's saved-addresses screen. Mirrors the
/// cart's inline add form (``AddressPickerView``) field-for-field, then
/// adds the edit affordances: an "Edit address" title and a default toggle
/// that locks on when editing the row that already holds the default.
///
/// Every field routes through a reducer action rather than a two-way
/// binding on the draft so region uppercasing and validation run in one
/// place. The view never touches the API client directly.
struct AddressFormView: View {
  @Bindable var store: StoreOf<AddressFormFeature>

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: DankSpacing.md) {
        if let error = store.error {
          errorBanner(error)
        }

        formFields

        if store.isGeocoding || store.isSaving {
          HStack(spacing: DankSpacing.sm) {
            ProgressView().controlSize(.small)
            Text(store.isGeocoding ? "Looking up address…" : "Saving address…")
              .font(DankFont.bodySmall)
              .foregroundStyle(DankColor.Text.muted)
          }
          .padding(.top, DankSpacing.xs)
        }
      }
      .padding(DankSpacing.md)
    }
    .background(DankColor.cream.ignoresSafeArea())
    .navigationTitle(store.isEditing ? "Edit address" : "Add address")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { toolbarContent }
  }

  // MARK: - Toolbar

  @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
    ToolbarItem(placement: .cancellationAction) {
      Button("Cancel") { store.send(.cancelTapped) }
        .foregroundStyle(DankColor.primary)
    }
    ToolbarItem(placement: .confirmationAction) {
      Button("Save") { store.send(.saveTapped) }
        .disabled(!store.canSave)
        .foregroundStyle(store.canSave ? DankColor.primary : DankColor.Text.muted)
    }
  }

  // MARK: - Fields

  @ViewBuilder private var formFields: some View {
    DankInput(
      label: "Label (optional)",
      placeholder: "Home, Work, …",
      text: Binding(
        get: { store.label },
        set: { store.send(.updateLabel($0)) }
      ),
      kind: .text
    )

    DankInput(
      label: "Street address",
      placeholder: "1100 Hennepin Ave",
      text: Binding(
        get: { store.line1 },
        set: { store.send(.updateLine1($0)) }
      ),
      kind: .text
    )

    DankInput(
      label: "Apartment / unit (optional)",
      placeholder: "Apt 204",
      text: Binding(
        get: { store.line2 },
        set: { store.send(.updateLine2($0)) }
      ),
      kind: .text
    )

    HStack(spacing: DankSpacing.sm) {
      DankInput(
        label: "City",
        placeholder: "Minneapolis",
        text: Binding(
          get: { store.city },
          set: { store.send(.updateCity($0)) }
        ),
        kind: .text
      )
      DankInput(
        label: "State",
        placeholder: "MN",
        text: Binding(
          get: { store.region },
          set: { store.send(.updateRegion($0.uppercased())) }
        ),
        kind: .text
      )
      .frame(width: 96)
    }

    DankInput(
      label: "ZIP",
      placeholder: "55403",
      text: Binding(
        get: { store.postalCode },
        set: { store.send(.updatePostalCode($0)) }
      ),
      kind: .text
    )

    DankInput(
      label: "Delivery instructions (optional)",
      placeholder: "Buzz #204",
      text: Binding(
        get: { store.deliveryInstructions },
        set: { store.send(.updateDeliveryInstructions($0)) }
      ),
      kind: .text
    )

    Toggle(isOn: Binding(
      get: { store.setAsDefault },
      set: { store.send(.toggleSetAsDefault($0)) }
    )) {
      Text("Make this my default address")
        .font(DankFont.bodySmall)
        .foregroundStyle(DankColor.Text.primary)
    }
    .tint(DankColor.primary)
    .disabled(store.isEditingDefault)
    .padding(.top, DankSpacing.xs)

    if store.isEditingDefault {
      Text("This is your default address. Set another address as default to change it.")
        .font(DankFont.caption)
        .foregroundStyle(DankColor.Text.muted)
    }
  }

  private func errorBanner(_ message: String) -> some View {
    HStack(alignment: .top, spacing: DankSpacing.xs) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(DankColor.Semantic.danger)
        .accessibilityHidden(true)
      Text(message)
        .font(DankFont.bodySmall)
        .foregroundStyle(DankColor.Text.primary)
      Spacer(minLength: 0)
    }
    .padding(DankSpacing.md)
    .background(DankColor.Semantic.danger.opacity(0.08))
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Error: \(message)")
  }
}
