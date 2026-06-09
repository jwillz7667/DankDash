import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Payment-methods manager reached from the Account tab. Lists the user's
/// saved methods, links a bank account through Aeropay's hosted flow,
/// promotes a method to default, and deletes (soft-delete) with a
/// confirmation step.
///
/// The Aeropay link is an out-of-band flow: tapping "Link bank account"
/// requests a hosted-link session, the view opens `linkSession.hostedUrl`
/// in a Safari sheet, and when the sheet closes (`linkSheetDismissed`) the
/// feature re-lists — the `bank_account.linked` webhook promotes the new
/// row from `pending` to `active` server-side, so a fresh GET is the only
/// reliable way to reflect it.
///
/// Cross-row mutations (make-default) re-list afterwards rather than
/// reconciling locally: the singleton-default flip silently demotes the
/// previous holder, which is easier to trust from a fresh GET. Delete is
/// the exception — it removes a single row, dropped locally with no
/// refetch.
@Reducer
public struct PaymentMethodsFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable {
    public var paymentMethods: [PaymentMethod]
    public var isLoading: Bool
    public var error: String?
    /// True while a hosted-link session request is in flight (the "Link
    /// bank account" button shows a spinner and is disabled).
    public var isLinking: Bool
    /// Non-nil once a link session is in hand; the view binds the Safari
    /// sheet's presentation to this. Cleared on `linkSheetDismissed`.
    public var linkSession: AeropayLinkSession?
    /// Method awaiting delete confirmation; the view binds the confirm
    /// dialog to this being non-nil.
    public var pendingDeleteID: UUID?
    /// Row with an in-flight promote/delete. Disables that row's actions so
    /// a double-tap can't fire two requests.
    public var rowActionID: UUID?

    public init(
      paymentMethods: [PaymentMethod] = [],
      isLoading: Bool = false,
      error: String? = nil,
      isLinking: Bool = false,
      linkSession: AeropayLinkSession? = nil,
      pendingDeleteID: UUID? = nil,
      rowActionID: UUID? = nil
    ) {
      self.paymentMethods = paymentMethods
      self.isLoading = isLoading
      self.error = error
      self.isLinking = isLinking
      self.linkSession = linkSession
      self.pendingDeleteID = pendingDeleteID
      self.rowActionID = rowActionID
    }

    public var pendingDeletePaymentMethod: PaymentMethod? {
      guard let pendingDeleteID else { return nil }
      return paymentMethods.first { $0.id == pendingDeleteID }
    }
  }

  public enum Action: Sendable, Equatable {
    case onAppear
    case refreshTapped
    case paymentMethodsLoaded(Result<[PaymentMethod], EquatableError>)

    case linkBankTapped
    case linkSessionResponse(Result<AeropayLinkSession, EquatableError>)
    case linkSheetDismissed

    case makeDefaultTapped(UUID)
    case makeDefaultResponse(Result<PaymentMethod, EquatableError>)

    case deleteTapped(UUID)
    case deleteCanceled
    case deleteConfirmed
    case deleteResponse(Result<UUID, EquatableError>)
  }

  @Dependency(\.paymentMethodAPIClient) var paymentMethodAPIClient

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .onAppear:
        // First entry only — a re-appear keeps whatever the last load /
        // mutation produced.
        guard !state.isLoading, state.paymentMethods.isEmpty else { return .none }
        state.isLoading = true
        return reload()

      case .refreshTapped:
        return reload()

      case .paymentMethodsLoaded(.success(let methods)):
        state.isLoading = false
        state.paymentMethods = methods
        return .none

      case .paymentMethodsLoaded(.failure(let error)):
        state.isLoading = false
        state.error = error.message
        return .none

      // MARK: Aeropay link

      case .linkBankTapped:
        guard !state.isLinking else { return .none }
        state.isLinking = true
        state.error = nil
        return .run { [paymentMethodAPIClient] send in
          do {
            let session = try await paymentMethodAPIClient.linkAeropay()
            await send(.linkSessionResponse(.success(session)))
          } catch {
            await send(.linkSessionResponse(.failure(EquatableError(error))))
          }
        }

      case .linkSessionResponse(.success(let session)):
        state.isLinking = false
        state.linkSession = session
        return .none

      case .linkSessionResponse(.failure(let error)):
        state.isLinking = false
        state.error = error.message
        return .none

      case .linkSheetDismissed:
        // The user closed Safari. Whether or not they finished the link, the
        // webhook is the source of truth for promotion to `active`, so re-list
        // to surface a newly linked (or still-pending) method.
        guard state.linkSession != nil else { return .none }
        state.linkSession = nil
        return reload()

      // MARK: Make default

      case .makeDefaultTapped(let id):
        guard state.rowActionID == nil,
              let method = state.paymentMethods.first(where: { $0.id == id }),
              !method.isDefault,
              method.isUsable else { return .none }
        state.rowActionID = id
        state.error = nil
        return .run { [paymentMethodAPIClient] send in
          do {
            let updated = try await paymentMethodAPIClient.setDefault(id)
            await send(.makeDefaultResponse(.success(updated)))
          } catch {
            await send(.makeDefaultResponse(.failure(EquatableError(error))))
          }
        }

      case .makeDefaultResponse(.success):
        state.rowActionID = nil
        // The PATCH returns only the promoted row; the previous default was
        // demoted server-side, so re-list to reflect both.
        return reload()

      case .makeDefaultResponse(.failure(let error)):
        state.rowActionID = nil
        state.error = error.message
        return .none

      // MARK: Delete (confirm → soft-delete)

      case .deleteTapped(let id):
        // Block while another row mutation is in flight — only the busy
        // row's buttons are disabled in the view, so a delete on a
        // different row could otherwise clobber `rowActionID`.
        guard state.rowActionID == nil,
              state.paymentMethods.contains(where: { $0.id == id }) else { return .none }
        state.pendingDeleteID = id
        return .none

      case .deleteCanceled:
        state.pendingDeleteID = nil
        return .none

      case .deleteConfirmed:
        guard let id = state.pendingDeleteID else { return .none }
        state.pendingDeleteID = nil
        state.rowActionID = id
        state.error = nil
        return .run { [paymentMethodAPIClient] send in
          do {
            try await paymentMethodAPIClient.deletePaymentMethod(id)
            await send(.deleteResponse(.success(id)))
          } catch {
            await send(.deleteResponse(.failure(EquatableError(error))))
          }
        }

      case .deleteResponse(.success(let id)):
        state.rowActionID = nil
        state.paymentMethods.removeAll { $0.id == id }
        return .none

      case .deleteResponse(.failure(let error)):
        state.rowActionID = nil
        state.error = error.message
        return .none
      }
    }
  }

  private func reload() -> Effect<Action> {
    .run { [paymentMethodAPIClient] send in
      do {
        let methods = try await paymentMethodAPIClient.listPaymentMethods()
        await send(.paymentMethodsLoaded(.success(methods)))
      } catch {
        await send(.paymentMethodsLoaded(.failure(EquatableError(error))))
      }
    }
  }
}
