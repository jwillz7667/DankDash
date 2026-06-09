import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures
import SafariServices

/// Payment-methods screen bound to ``PaymentMethodsFeature``. Pushed from
/// the Account tab. Lists the user's saved methods with per-row actions
/// (make default, delete), a "Link bank account" button that opens
/// Aeropay's hosted flow in a Safari sheet, and a delete-confirmation
/// alert so a stray tap can't drop a method.
///
/// Aeropay is the only fundable rail (cannabis can't use the card
/// networks). Linking is out-of-band: the button requests a hosted-link
/// session, Safari opens it, and when the sheet closes the feature
/// re-lists — the `bank_account.linked` webhook promotes the new row from
/// `pending` to `active` server-side.
struct PaymentMethodsView: View {
  @Bindable var store: StoreOf<PaymentMethodsFeature>

  var body: some View {
    ScrollView {
      VStack(spacing: DankSpacing.md) {
        if let error = store.error {
          errorBanner(error)
        }

        if store.isLoading && store.paymentMethods.isEmpty {
          loadingRow
        } else if store.paymentMethods.isEmpty {
          emptyState
        } else {
          ForEach(store.paymentMethods, id: \.id) { method in
            methodCard(method)
          }
        }

        DankButton(
          store.isLinking ? "Opening Aeropay…" : "+ Link bank account",
          style: .secondary,
          size: .medium
        ) {
          store.send(.linkBankTapped)
        }
        .disabled(store.isLinking)
        .opacity(store.isLinking ? 0.6 : 1)
        .padding(.top, DankSpacing.xs)

        disclaimer
      }
      .padding(DankSpacing.lg)
    }
    .background(DankColor.cream.ignoresSafeArea())
    .navigationTitle("Payment methods")
    .navigationBarTitleDisplayMode(.inline)
    .task { store.send(.onAppear) }
    .refreshable { store.send(.refreshTapped) }
    .fullScreenCover(
      isPresented: Binding(
        get: { store.linkSession != nil },
        set: { _ in /* dismissal flows through the SafariView delegate */ }
      )
    ) {
      if let session = store.linkSession {
        AeropayLinkSafariView(
          url: session.hostedUrl,
          onDismiss: { store.send(.linkSheetDismissed) }
        )
        .ignoresSafeArea()
      }
    }
    .alert(
      "Remove payment method?",
      isPresented: Binding(
        get: { store.pendingDeleteID != nil },
        set: { isPresented in
          if !isPresented { store.send(.deleteCanceled) }
        }
      ),
      presenting: store.pendingDeletePaymentMethod
    ) { _ in
      Button("Remove", role: .destructive) { store.send(.deleteConfirmed) }
      Button("Cancel", role: .cancel) { store.send(.deleteCanceled) }
    } message: { method in
      Text("\(method.displayName) will be removed from your account.")
    }
  }

  // MARK: - Rows

  private func methodCard(_ method: PaymentMethod) -> some View {
    let isBusy = store.rowActionID == method.id
    return DankCard {
      VStack(alignment: .leading, spacing: DankSpacing.sm) {
        HStack(spacing: DankSpacing.sm) {
          Image(systemName: iconName(for: method.type))
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(DankColor.primary)
            .frame(width: 32, height: 32)
            .accessibilityHidden(true)

          VStack(alignment: .leading, spacing: DankSpacing.xxs) {
            Text(method.displayName)
              .font(DankFont.body.weight(.semibold))
              .foregroundStyle(DankColor.Text.primary)
            HStack(spacing: DankSpacing.xs) {
              if method.isDefault {
                DankBadge("Default", tone: .accent)
              }
              if let status = statusBadge(for: method.status) {
                DankBadge(status.title, tone: status.tone)
              }
            }
          }
          Spacer(minLength: 0)
        }

        Divider().overlay(DankColor.primary.opacity(0.12))

        HStack(spacing: DankSpacing.md) {
          if !method.isDefault && method.isUsable {
            actionButton("Make default", icon: "star", tint: DankColor.primary) {
              store.send(.makeDefaultTapped(method.id))
            }
          }

          Spacer(minLength: 0)

          if isBusy {
            ProgressView().controlSize(.small)
          }

          actionButton("Remove", icon: "trash", tint: DankColor.Semantic.danger) {
            store.send(.deleteTapped(method.id))
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

  private func iconName(for type: PaymentMethodType) -> String {
    switch type {
    case .aeropayACH: "building.columns"
    case .cash: "banknote"
    }
  }

  private func statusBadge(for status: PaymentMethodStatus) -> (title: String, tone: DankBadge.Tone)? {
    switch status {
    case .active: nil
    case .pending: ("Linking…", .warning)
    case .failed: ("Link failed", .danger)
    case .revoked: ("Unavailable", .neutral)
    }
  }

  // MARK: - States

  private var loadingRow: some View {
    HStack(spacing: DankSpacing.sm) {
      ProgressView().controlSize(.small)
      Text("Loading payment methods…")
        .font(DankFont.bodySmall)
        .foregroundStyle(DankColor.Text.muted)
      Spacer(minLength: 0)
    }
    .padding(.vertical, DankSpacing.lg)
  }

  private var emptyState: some View {
    VStack(spacing: DankSpacing.sm) {
      Image(systemName: "creditcard.trianglebadge.exclamationmark")
        .font(.system(size: 32, weight: .regular))
        .foregroundStyle(DankColor.Text.muted)
        .accessibilityHidden(true)
      Text("No payment methods yet")
        .font(DankFont.body.weight(.semibold))
        .foregroundStyle(DankColor.Text.primary)
      Text("Link a bank account to pay at checkout.")
        .font(DankFont.bodySmall)
        .foregroundStyle(DankColor.Text.secondary)
        .multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, DankSpacing.xl)
  }

  private var disclaimer: some View {
    Text("Bank accounts are linked securely through Aeropay. DankDash never sees your bank login.")
      .font(DankFont.caption)
      .foregroundStyle(DankColor.Text.muted)
      .multilineTextAlignment(.center)
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

/// Thin `UIViewControllerRepresentable` over `SFSafariViewController` for
/// the Aeropay hosted bank-link flow. Kept private to this file rather than
/// shared with ``CheckoutSafariView`` deliberately: that surface is
/// compliance-critical (Apple §10.4 checkout handoff) and the two flows
/// shouldn't share a mutable component. The `onDismiss` closure fires both
/// on the user's "Done" tap and on programmatic dismissal; the reducer's
/// `.linkSheetDismissed` treats both the same and re-lists.
private struct AeropayLinkSafariView: UIViewControllerRepresentable {
  let url: URL
  let onDismiss: () -> Void

  func makeCoordinator() -> Coordinator { Coordinator(onDismiss: onDismiss) }

  func makeUIViewController(context: Context) -> SFSafariViewController {
    let config = SFSafariViewController.Configuration()
    config.entersReaderIfAvailable = false
    config.barCollapsingEnabled = true
    let controller = SFSafariViewController(url: url, configuration: config)
    controller.preferredControlTintColor = UIColor(DankColor.primary)
    controller.dismissButtonStyle = .done
    controller.delegate = context.coordinator
    return controller
  }

  func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {
    // The Safari controller owns its URL once presented; a new link session
    // would require a fresh presentation, which the reducer drives by
    // clearing and re-setting `linkSession`.
  }

  final class Coordinator: NSObject, SFSafariViewControllerDelegate {
    let onDismiss: () -> Void

    init(onDismiss: @escaping () -> Void) {
      self.onDismiss = onDismiss
    }

    func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
      onDismiss()
    }
  }
}
