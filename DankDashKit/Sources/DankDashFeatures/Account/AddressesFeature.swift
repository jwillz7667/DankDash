import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Saved-addresses manager reached from the Account tab. Lists the user's
/// addresses, promotes one to default, deletes (soft-delete) with a
/// confirmation step, and hosts the add/edit form (``AddressFormFeature``)
/// as a presented child.
///
/// Mutations that change cross-row state — add, edit, and make-default —
/// re-list from the server afterwards rather than reconciling locally: the
/// authoritative default-first ordering and the singleton-default flip
/// (which silently demotes the previous holder) are easier to trust from a
/// fresh GET than to mirror by hand. Delete is the exception; it removes a
/// single row, so the row is dropped locally with no refetch.
@Reducer
public struct AddressesFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable {
    public var addresses: [UserAddress]
    public var isLoading: Bool
    public var error: String?
    public var form: AddressFormFeature.State?
    /// Address awaiting delete confirmation; the view binds the confirm
    /// dialog's presentation to this being non-nil.
    public var pendingDeleteID: UUID?
    /// Row with an in-flight promote/delete. Disables that row's actions so
    /// a double-tap can't fire two requests.
    public var rowActionID: UUID?

    public init(
      addresses: [UserAddress] = [],
      isLoading: Bool = false,
      error: String? = nil,
      form: AddressFormFeature.State? = nil,
      pendingDeleteID: UUID? = nil,
      rowActionID: UUID? = nil
    ) {
      self.addresses = addresses
      self.isLoading = isLoading
      self.error = error
      self.form = form
      self.pendingDeleteID = pendingDeleteID
      self.rowActionID = rowActionID
    }

    public var pendingDeleteAddress: UserAddress? {
      guard let pendingDeleteID else { return nil }
      return addresses.first { $0.id == pendingDeleteID }
    }
  }

  public enum Action: Sendable, Equatable {
    case onAppear
    case refreshTapped
    case addressesLoaded(Result<[UserAddress], EquatableError>)

    case addTapped
    case editTapped(UUID)
    case formDismissed

    case makeDefaultTapped(UUID)
    case makeDefaultResponse(Result<UserAddress, EquatableError>)

    case deleteTapped(UUID)
    case deleteCanceled
    case deleteConfirmed
    case deleteResponse(Result<UUID, EquatableError>)

    case form(AddressFormFeature.Action)
  }

  @Dependency(\.addressAPIClient) var addressAPIClient

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .onAppear:
        // First entry only — a re-appear (e.g. returning from the form
        // sheet) keeps whatever the last load / mutation produced.
        guard !state.isLoading, state.addresses.isEmpty else { return .none }
        state.isLoading = true
        return reload()

      case .refreshTapped:
        return reload()

      case .addressesLoaded(.success(let addresses)):
        state.isLoading = false
        state.addresses = addresses
        return .none

      case .addressesLoaded(.failure(let error)):
        state.isLoading = false
        state.error = error.message
        return .none

      // MARK: Add / edit form

      case .addTapped:
        state.error = nil
        state.form = AddressFormFeature.State(mode: .add)
        return .none

      case .editTapped(let id):
        guard let address = state.addresses.first(where: { $0.id == id }) else { return .none }
        state.error = nil
        state.form = AddressFormFeature.State(mode: .edit(address))
        return .none

      case .formDismissed:
        state.form = nil
        return .none

      case .form(.delegate(.saved)):
        // Re-list so the new/edited row lands in authoritative order with
        // the default flag resolved server-side.
        state.form = nil
        return reload()

      case .form(.delegate(.cancelled)):
        state.form = nil
        return .none

      case .form:
        return .none

      // MARK: Make default

      case .makeDefaultTapped(let id):
        guard state.rowActionID == nil,
              let address = state.addresses.first(where: { $0.id == id }),
              !address.isDefault else { return .none }
        state.rowActionID = id
        state.error = nil
        return .run { [addressAPIClient] send in
          do {
            let updated = try await addressAPIClient.patchAddress(
              id,
              PatchAddressRequestDTO(isDefault: true)
            )
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
        // Block while another row mutation (promote/delete) is in flight —
        // only the busy row's buttons are disabled in the view, so a delete
        // on a *different* row could otherwise clobber `rowActionID` and
        // strand the in-flight row's spinner.
        guard state.rowActionID == nil,
              state.addresses.contains(where: { $0.id == id }) else { return .none }
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
        return .run { [addressAPIClient] send in
          do {
            try await addressAPIClient.deleteAddress(id)
            await send(.deleteResponse(.success(id)))
          } catch {
            await send(.deleteResponse(.failure(EquatableError(error))))
          }
        }

      case .deleteResponse(.success(let id)):
        state.rowActionID = nil
        state.addresses.removeAll { $0.id == id }
        return .none

      case .deleteResponse(.failure(let error)):
        state.rowActionID = nil
        state.error = error.message
        return .none
      }
    }
    .ifLet(\.form, action: \.form) {
      AddressFormFeature()
    }
  }

  private func reload() -> Effect<Action> {
    .run { [addressAPIClient] send in
      do {
        let addresses = try await addressAPIClient.listAddresses()
        await send(.addressesLoaded(.success(addresses)))
      } catch {
        await send(.addressesLoaded(.failure(EquatableError(error))))
      }
    }
  }
}
