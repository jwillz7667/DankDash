import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// Sheet view bound to ``AddressPickerFeature``. Two modes share the
/// same surface:
///
/// 1. **Picker** (default): list saved addresses, tap to highlight,
///    "Use this address" confirms and bubbles back the selection.
/// 2. **Inline add** (`state.draft != nil`): form with line-1 / city /
///    region / postal-code fields, geocode + create on save.
///
/// The view never touches `addressAPIClient` itself — every effect is a
/// reducer action. Dismissal flows through `.dismissTapped` so the
/// reducer can emit `.delegate(.dismissed)` and the parent cart can
/// tear down the sheet.
struct AddressPickerView: View {
  @Bindable var store: StoreOf<AddressPickerFeature>

  var body: some View {
    Group {
      if store.draft != nil {
        addNewForm
      } else {
        pickerList
      }
    }
    .background(DankColor.cream.ignoresSafeArea())
    .navigationTitle(store.draft != nil ? "Add address" : "Choose address")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { toolbarContent }
    .task { store.send(.onAppear) }
  }

  // MARK: - Toolbar

  @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
    ToolbarItem(placement: .cancellationAction) {
      Button("Cancel") {
        if store.draft != nil {
          store.send(.cancelAddingNew)
        } else {
          store.send(.dismissTapped)
        }
      }
      .foregroundStyle(DankColor.primary)
    }

    if store.draft != nil {
      ToolbarItem(placement: .confirmationAction) {
        Button("Save") {
          store.send(.saveDraftTapped)
        }
        .disabled(!store.canSubmitDraft)
        .foregroundStyle(store.canSubmitDraft ? DankColor.primary : DankColor.Text.muted)
      }
    } else {
      ToolbarItem(placement: .confirmationAction) {
        Button("Use this") {
          store.send(.confirmSelection)
        }
        .disabled(store.selectedAddressId == nil)
        .foregroundStyle(store.selectedAddressId == nil ? DankColor.Text.muted : DankColor.primary)
      }
    }
  }

  // MARK: - Picker list

  private var pickerList: some View {
    ScrollView {
      VStack(spacing: DankSpacing.sm) {
        if let error = store.error {
          errorBanner(error)
        }

        if store.isLoading {
          HStack(spacing: DankSpacing.sm) {
            ProgressView().controlSize(.small)
            Text("Loading addresses…")
              .font(DankFont.bodySmall)
              .foregroundStyle(DankColor.Text.muted)
            Spacer(minLength: 0)
          }
          .padding(.vertical, DankSpacing.lg)
        }

        ForEach(store.addresses, id: \.id) { address in
          AddressRow(
            address: address,
            accessory: address.id == store.selectedAddressId ? .selected : .none,
            action: { store.send(.selectAddress(address.id)) }
          )
          .padding(.horizontal, DankSpacing.md)
          .background(DankColor.cream)
          .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous)
              .strokeBorder(
                address.id == store.selectedAddressId
                  ? DankColor.primary
                  : DankColor.primary.opacity(0.12),
                lineWidth: address.id == store.selectedAddressId ? 1.5 : 1
              )
          )
        }

        DankButton(
          "+ Add new address",
          style: .secondary,
          size: .medium,
          action: { store.send(.startAddingNew) }
        )
        .padding(.top, DankSpacing.sm)
      }
      .padding(DankSpacing.md)
    }
  }

  // MARK: - Add new form

  /// Bind the form fields through update-actions rather than two-way
  /// bindings on `draft` itself — TCA observability covers the redraw
  /// cycle, and we want every keystroke to go through the reducer so
  /// validation + region uppercasing can run in one place.
  private var addNewForm: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: DankSpacing.md) {
        if let error = store.error {
          errorBanner(error)
        }

        if let draft = store.draft {
          formFields(draft: draft)

          if store.isGeocoding || store.isCreating {
            HStack(spacing: DankSpacing.sm) {
              ProgressView().controlSize(.small)
              Text(store.isGeocoding ? "Looking up address…" : "Saving address…")
                .font(DankFont.bodySmall)
                .foregroundStyle(DankColor.Text.muted)
            }
            .padding(.top, DankSpacing.xs)
          }
        }
      }
      .padding(DankSpacing.md)
    }
  }

  @ViewBuilder
  private func formFields(draft: AddressPickerFeature.NewAddressDraft) -> some View {
    DankInput(
      label: "Label (optional)",
      placeholder: "Home, Work, …",
      text: Binding(
        get: { draft.label },
        set: { store.send(.updateLabel($0)) }
      ),
      kind: .text
    )

    DankInput(
      label: "Street address",
      placeholder: "1100 Hennepin Ave",
      text: Binding(
        get: { draft.line1 },
        set: { store.send(.updateLine1($0)) }
      ),
      kind: .text
    )

    DankInput(
      label: "Apartment / unit (optional)",
      placeholder: "Apt 204",
      text: Binding(
        get: { draft.line2 },
        set: { store.send(.updateLine2($0)) }
      ),
      kind: .text
    )

    HStack(spacing: DankSpacing.sm) {
      DankInput(
        label: "City",
        placeholder: "Minneapolis",
        text: Binding(
          get: { draft.city },
          set: { store.send(.updateCity($0)) }
        ),
        kind: .text
      )
      DankInput(
        label: "State",
        placeholder: "MN",
        text: Binding(
          get: { draft.region },
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
        get: { draft.postalCode },
        set: { store.send(.updatePostalCode($0)) }
      ),
      kind: .text
    )

    DankInput(
      label: "Delivery instructions (optional)",
      placeholder: "Buzz #204",
      text: Binding(
        get: { draft.deliveryInstructions },
        set: { store.send(.updateDeliveryInstructions($0)) }
      ),
      kind: .text
    )

    Toggle(isOn: Binding(
      get: { draft.setAsDefault },
      set: { store.send(.toggleSetAsDefault($0)) }
    )) {
      Text("Make this my default address")
        .font(DankFont.bodySmall)
        .foregroundStyle(DankColor.Text.primary)
    }
    .tint(DankColor.primary)
    .padding(.top, DankSpacing.xs)
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
