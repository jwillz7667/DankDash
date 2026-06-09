import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// Saved-addresses screen bound to ``AddressesFeature``. Pushed from the
/// Account tab. Lists the user's delivery addresses with per-row actions
/// (make default, edit, delete), an add button, and presents the
/// ``AddressFormView`` as a sheet. Delete is gated behind a confirmation
/// alert so a stray tap can't drop an address.
struct AddressesView: View {
  @Bindable var store: StoreOf<AddressesFeature>

  var body: some View {
    ScrollView {
      VStack(spacing: DankSpacing.md) {
        if let error = store.error {
          errorBanner(error)
        }

        if store.isLoading && store.addresses.isEmpty {
          loadingRow
        } else if store.addresses.isEmpty {
          emptyState
        } else {
          ForEach(store.addresses, id: \.id) { address in
            addressCard(address)
          }
        }

        DankButton("+ Add address", style: .secondary, size: .medium) {
          store.send(.addTapped)
        }
        .padding(.top, DankSpacing.xs)
      }
      .padding(DankSpacing.lg)
    }
    .background(DankColor.cream.ignoresSafeArea())
    .navigationTitle("Saved addresses")
    .navigationBarTitleDisplayMode(.inline)
    .task { store.send(.onAppear) }
    .refreshable { store.send(.refreshTapped) }
    .sheet(
      isPresented: Binding(
        get: { store.form != nil },
        set: { isPresented in
          if !isPresented { store.send(.formDismissed) }
        }
      )
    ) {
      if let formStore = store.scope(state: \.form, action: \.form) {
        NavigationStack {
          AddressFormView(store: formStore)
        }
      }
    }
    .alert(
      "Delete address?",
      isPresented: Binding(
        get: { store.pendingDeleteID != nil },
        set: { isPresented in
          if !isPresented { store.send(.deleteCanceled) }
        }
      ),
      presenting: store.pendingDeleteAddress
    ) { _ in
      Button("Delete", role: .destructive) { store.send(.deleteConfirmed) }
      Button("Cancel", role: .cancel) { store.send(.deleteCanceled) }
    } message: { address in
      Text("\(address.oneLine) will be removed from your saved addresses.")
    }
  }

  // MARK: - Rows

  private func addressCard(_ address: UserAddress) -> some View {
    let isBusy = store.rowActionID == address.id
    return DankCard {
      VStack(alignment: .leading, spacing: DankSpacing.sm) {
        AddressRow(address: address)

        Divider().overlay(DankColor.primary.opacity(0.12))

        HStack(spacing: DankSpacing.md) {
          if !address.isDefault {
            actionButton(
              "Make default",
              icon: "star",
              tint: DankColor.primary
            ) {
              store.send(.makeDefaultTapped(address.id))
            }
          }

          Spacer(minLength: 0)

          if isBusy {
            ProgressView().controlSize(.small)
          }

          actionButton("Edit", icon: "pencil", tint: DankColor.primary) {
            store.send(.editTapped(address.id))
          }

          actionButton("Delete", icon: "trash", tint: DankColor.Semantic.danger) {
            store.send(.deleteTapped(address.id))
          }
        }
        .disabled(isBusy)
        .opacity(isBusy ? 0.5 : 1)
      }
    }
  }

  private func actionButton(
    _ title: String,
    icon: String,
    tint: Color,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      HStack(spacing: DankSpacing.xxs) {
        Image(systemName: icon)
          .font(.system(size: 12, weight: .semibold))
        Text(title)
          .font(DankFont.bodySmall.weight(.semibold))
      }
      .foregroundStyle(tint)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(title)
  }

  // MARK: - States

  private var loadingRow: some View {
    HStack(spacing: DankSpacing.sm) {
      ProgressView().controlSize(.small)
      Text("Loading addresses…")
        .font(DankFont.bodySmall)
        .foregroundStyle(DankColor.Text.muted)
      Spacer(minLength: 0)
    }
    .padding(.vertical, DankSpacing.lg)
  }

  private var emptyState: some View {
    VStack(spacing: DankSpacing.sm) {
      Image(systemName: "mappin.slash")
        .font(.system(size: 32, weight: .regular))
        .foregroundStyle(DankColor.Text.muted)
        .accessibilityHidden(true)
      Text("No saved addresses yet")
        .font(DankFont.body.weight(.semibold))
        .foregroundStyle(DankColor.Text.primary)
      Text("Add a delivery address to speed up checkout.")
        .font(DankFont.bodySmall)
        .foregroundStyle(DankColor.Text.secondary)
        .multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, DankSpacing.xl)
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
