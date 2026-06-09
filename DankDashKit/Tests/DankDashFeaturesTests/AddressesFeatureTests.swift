import XCTest
import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

@MainActor
final class AddressesFeatureTests: XCTestCase {
  // MARK: - Load

  func test_onAppear_loadsAddresses() async {
    let a = makeAddress(isDefault: true)
    let b = makeAddress(isDefault: false)
    let store = TestStore(initialState: AddressesFeature.State()) {
      AddressesFeature()
    } withDependencies: {
      $0.addressAPIClient.listAddresses = { [a, b] }
    }

    await store.send(.onAppear) { $0.isLoading = true }
    await store.receive(\.addressesLoaded.success) {
      $0.isLoading = false
      $0.addresses = [a, b]
    }
  }

  func test_onAppear_whenAlreadyLoaded_isNoop() async {
    let a = makeAddress(isDefault: true)
    let store = TestStore(initialState: AddressesFeature.State(addresses: [a])) {
      AddressesFeature()
    }
    // Re-appear after the first load (or returning from the form sheet)
    // must not refetch — the list keeps the last authoritative result.
    await store.send(.onAppear)
  }

  func test_onAppear_failure_surfacesError() async {
    let store = TestStore(initialState: AddressesFeature.State()) {
      AddressesFeature()
    } withDependencies: {
      $0.addressAPIClient.listAddresses = { throw AddressAPIError.unimplemented("listAddresses") }
    }

    await store.send(.onAppear) { $0.isLoading = true }
    await store.receive(\.addressesLoaded.failure) {
      $0.isLoading = false
      $0.error = String(describing: AddressAPIError.unimplemented("listAddresses"))
    }
  }

  func test_refreshTapped_reloadsWithoutLoadingFlag() async {
    let a = makeAddress(isDefault: true)
    let store = TestStore(initialState: AddressesFeature.State(addresses: [a])) {
      AddressesFeature()
    } withDependencies: {
      $0.addressAPIClient.listAddresses = { [a] }
    }
    // refreshable pull doesn't flip the full-screen loading row.
    await store.send(.refreshTapped)
    await store.receive(\.addressesLoaded.success)
  }

  // MARK: - Form open/close

  func test_addTapped_opensAddForm() async {
    let store = TestStore(initialState: AddressesFeature.State()) {
      AddressesFeature()
    }
    await store.send(.addTapped) {
      $0.form = AddressFormFeature.State(mode: .add)
    }
  }

  func test_editTapped_opensEditFormForKnownRow() async {
    let a = makeAddress(isDefault: false)
    let store = TestStore(initialState: AddressesFeature.State(addresses: [a])) {
      AddressesFeature()
    }
    await store.send(.editTapped(a.id)) {
      $0.form = AddressFormFeature.State(mode: .edit(a))
    }
  }

  func test_editTapped_unknownRow_isNoop() async {
    let a = makeAddress(isDefault: false)
    let store = TestStore(initialState: AddressesFeature.State(addresses: [a])) {
      AddressesFeature()
    }
    await store.send(.editTapped(UUID()))
  }

  func test_formSavedDelegate_dismissesAndReloads() async {
    let a = makeAddress(isDefault: true)
    let b = makeAddress(isDefault: false)
    let store = TestStore(
      initialState: AddressesFeature.State(
        addresses: [a],
        form: AddressFormFeature.State(mode: .add)
      )
    ) {
      AddressesFeature()
    } withDependencies: {
      $0.addressAPIClient.listAddresses = { [a, b] }
    }

    await store.send(.form(.delegate(.saved(b)))) { $0.form = nil }
    await store.receive(\.addressesLoaded.success) { $0.addresses = [a, b] }
  }

  func test_formCancelledDelegate_dismissesWithoutReload() async {
    let store = TestStore(
      initialState: AddressesFeature.State(form: AddressFormFeature.State(mode: .add))
    ) {
      AddressesFeature()
    }
    await store.send(.form(.delegate(.cancelled))) { $0.form = nil }
  }

  // MARK: - Make default

  func test_makeDefaultTapped_promotesThenReloads() async {
    let a = makeAddress(isDefault: false)
    let b = makeAddress(isDefault: true)
    let promotedA = a.with(isDefault: true)
    let demotedB = b.with(isDefault: false)
    let probe = Locker<(UUID, PatchAddressRequestDTO)?>(value: nil)

    let store = TestStore(
      initialState: AddressesFeature.State(addresses: [a, b])
    ) {
      AddressesFeature()
    } withDependencies: {
      $0.addressAPIClient.patchAddress = { id, body in
        await probe.set((id, body))
        return promotedA
      }
      $0.addressAPIClient.listAddresses = { [promotedA, demotedB] }
    }

    await store.send(.makeDefaultTapped(a.id)) { $0.rowActionID = a.id }
    await store.receive(\.makeDefaultResponse.success) { $0.rowActionID = nil }
    await store.receive(\.addressesLoaded.success) { $0.addresses = [promotedA, demotedB] }

    let observed = await probe.value
    XCTAssertEqual(observed?.0, a.id)
    XCTAssertEqual(observed?.1.isDefault, true)
  }

  func test_makeDefaultTapped_alreadyDefault_isNoop() async {
    let a = makeAddress(isDefault: true)
    let store = TestStore(initialState: AddressesFeature.State(addresses: [a])) {
      AddressesFeature()
    }
    await store.send(.makeDefaultTapped(a.id))
  }

  func test_makeDefaultTapped_whileRowBusy_isNoop() async {
    let a = makeAddress(isDefault: false)
    let b = makeAddress(isDefault: true)
    let store = TestStore(
      initialState: AddressesFeature.State(addresses: [a, b], rowActionID: b.id)
    ) {
      AddressesFeature()
    }
    // A promote is already in flight; a second tap must not fire.
    await store.send(.makeDefaultTapped(a.id))
  }

  func test_makeDefaultResponse_failure_surfacesError() async {
    let a = makeAddress(isDefault: false)
    let store = TestStore(initialState: AddressesFeature.State(addresses: [a])) {
      AddressesFeature()
    } withDependencies: {
      $0.addressAPIClient.patchAddress = { _, _ in
        throw AddressAPIError.unimplemented("patchAddress")
      }
    }

    await store.send(.makeDefaultTapped(a.id)) { $0.rowActionID = a.id }
    await store.receive(\.makeDefaultResponse.failure) {
      $0.rowActionID = nil
      $0.error = String(describing: AddressAPIError.unimplemented("patchAddress"))
    }
  }

  // MARK: - Delete

  func test_deleteFlow_confirmRemovesRow() async {
    let a = makeAddress(isDefault: false)
    let b = makeAddress(isDefault: true)
    let probe = Locker<UUID?>(value: nil)
    let store = TestStore(initialState: AddressesFeature.State(addresses: [a, b])) {
      AddressesFeature()
    } withDependencies: {
      $0.addressAPIClient.deleteAddress = { id in await probe.set(id) }
    }

    await store.send(.deleteTapped(a.id)) { $0.pendingDeleteID = a.id }
    await store.send(.deleteConfirmed) {
      $0.pendingDeleteID = nil
      $0.rowActionID = a.id
    }
    await store.receive(\.deleteResponse.success) {
      $0.rowActionID = nil
      $0.addresses = [b]
    }

    let observed = await probe.value
    XCTAssertEqual(observed, a.id)
  }

  func test_deleteCanceled_clearsPending() async {
    let a = makeAddress(isDefault: false)
    let store = TestStore(initialState: AddressesFeature.State(addresses: [a])) {
      AddressesFeature()
    }
    await store.send(.deleteTapped(a.id)) { $0.pendingDeleteID = a.id }
    await store.send(.deleteCanceled) { $0.pendingDeleteID = nil }
  }

  func test_deleteTapped_unknownRow_isNoop() async {
    let a = makeAddress(isDefault: false)
    let store = TestStore(initialState: AddressesFeature.State(addresses: [a])) {
      AddressesFeature()
    }
    await store.send(.deleteTapped(UUID()))
  }

  func test_deleteTapped_whileRowBusy_isNoop() async {
    let a = makeAddress(isDefault: false)
    let b = makeAddress(isDefault: true)
    // A make-default is already in flight on b; only b's buttons are disabled
    // in the view, so a delete tap on a must not clobber the row lock.
    let store = TestStore(
      initialState: AddressesFeature.State(addresses: [a, b], rowActionID: b.id)
    ) {
      AddressesFeature()
    }
    await store.send(.deleteTapped(a.id))
  }

  func test_deleteConfirmed_failure_keepsRowAndSurfacesError() async {
    let a = makeAddress(isDefault: false)
    let store = TestStore(initialState: AddressesFeature.State(addresses: [a])) {
      AddressesFeature()
    } withDependencies: {
      $0.addressAPIClient.deleteAddress = { _ in
        throw AddressAPIError.unimplemented("deleteAddress")
      }
    }

    await store.send(.deleteTapped(a.id)) { $0.pendingDeleteID = a.id }
    await store.send(.deleteConfirmed) {
      $0.pendingDeleteID = nil
      $0.rowActionID = a.id
    }
    await store.receive(\.deleteResponse.failure) {
      $0.rowActionID = nil
      $0.error = String(describing: AddressAPIError.unimplemented("deleteAddress"))
    }
    XCTAssertEqual(store.state.addresses, [a], "a failed delete leaves the row in place")
  }

  func test_deleteConfirmed_withoutPending_isNoop() async {
    let store = TestStore(initialState: AddressesFeature.State()) {
      AddressesFeature()
    }
    await store.send(.deleteConfirmed)
  }
}

// MARK: - Fixtures

private func makeAddress(isDefault: Bool) -> UserAddress {
  UserAddress(
    id: UUID(),
    label: "Home",
    line1: "100 Main St",
    line2: nil,
    city: "Minneapolis",
    region: "MN",
    postalCode: "55401",
    country: "US",
    location: Coordinate(latitude: 44.9778, longitude: -93.2650),
    isDefault: isDefault,
    isValidated: true,
    validatedAt: Date(timeIntervalSinceReferenceDate: 0),
    deliveryInstructions: nil,
    createdAt: Date(timeIntervalSinceReferenceDate: 0),
    updatedAt: Date(timeIntervalSinceReferenceDate: 0)
  )
}

private extension UserAddress {
  func with(isDefault: Bool) -> UserAddress {
    UserAddress(
      id: id,
      label: label,
      line1: line1,
      line2: line2,
      city: city,
      region: region,
      postalCode: postalCode,
      country: country,
      location: location,
      isDefault: isDefault,
      isValidated: isValidated,
      validatedAt: validatedAt,
      deliveryInstructions: deliveryInstructions,
      createdAt: createdAt,
      updatedAt: updatedAt
    )
  }
}

private actor Locker<T: Sendable> {
  private(set) var value: T
  init(value: T) { self.value = value }
  func set(_ newValue: T) { self.value = newValue }
}
