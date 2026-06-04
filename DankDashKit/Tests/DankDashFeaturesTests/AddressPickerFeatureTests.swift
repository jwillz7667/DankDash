import XCTest
import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

@MainActor
final class AddressPickerFeatureTests: XCTestCase {
  // MARK: - List load

  func test_onAppear_loadsAddressesAndPicksDefault() async {
    let nonDefault = makeAddress(isDefault: false)
    let defaultAddr = makeAddress(isDefault: true)

    let store = TestStore(initialState: AddressPickerFeature.State()) {
      AddressPickerFeature()
    } withDependencies: {
      $0.addressAPIClient.listAddresses = { [nonDefault, defaultAddr] }
    }

    await store.send(.onAppear) {
      $0.isLoading = true
    }
    await store.receive(\.addressesLoaded.success) {
      $0.isLoading = false
      $0.addresses = [nonDefault, defaultAddr]
      $0.selectedAddressId = defaultAddr.id
    }
  }

  func test_onAppear_emptyList_doesNotSelectAnything() async {
    let store = TestStore(initialState: AddressPickerFeature.State()) {
      AddressPickerFeature()
    } withDependencies: {
      $0.addressAPIClient.listAddresses = { [] }
    }

    await store.send(.onAppear) {
      $0.isLoading = true
    }
    await store.receive(\.addressesLoaded.success) {
      $0.isLoading = false
    }
    XCTAssertNil(store.state.selectedAddressId)
  }

  func test_onAppear_loadFailure_surfacesError() async {
    let store = TestStore(initialState: AddressPickerFeature.State()) {
      AddressPickerFeature()
    } withDependencies: {
      $0.addressAPIClient.listAddresses = {
        throw AddressAPIError.unimplemented("listAddresses")
      }
    }

    await store.send(.onAppear) {
      $0.isLoading = true
    }
    await store.receive(\.addressesLoaded.failure) {
      $0.isLoading = false
      $0.error = String(describing: AddressAPIError.unimplemented("listAddresses"))
    }
  }

  func test_onAppear_alreadyLoaded_isNoop() async {
    let existing = makeAddress(isDefault: true)
    let store = TestStore(
      initialState: AddressPickerFeature.State(
        addresses: [existing],
        selectedAddressId: existing.id
      )
    ) {
      AddressPickerFeature()
    }

    await store.send(.onAppear)
    // No effect — guard rejects.
  }

  // MARK: - Selection

  func test_selectAddress_updatesSelection() async {
    let a = makeAddress(isDefault: true)
    let b = makeAddress(isDefault: false)
    let store = TestStore(
      initialState: AddressPickerFeature.State(
        addresses: [a, b],
        selectedAddressId: a.id
      )
    ) {
      AddressPickerFeature()
    }

    await store.send(.selectAddress(b.id)) {
      $0.selectedAddressId = b.id
    }
  }

  func test_selectAddress_unknownId_isIgnored() async {
    let a = makeAddress(isDefault: true)
    let store = TestStore(
      initialState: AddressPickerFeature.State(
        addresses: [a],
        selectedAddressId: a.id
      )
    ) {
      AddressPickerFeature()
    }

    await store.send(.selectAddress(UUID()))
    // Unknown id rejected — no state change.
  }

  func test_confirmSelection_emitsDelegate() async {
    let a = makeAddress(isDefault: true)
    let store = TestStore(
      initialState: AddressPickerFeature.State(
        addresses: [a],
        selectedAddressId: a.id
      )
    ) {
      AddressPickerFeature()
    }

    await store.send(.confirmSelection)
    await store.receive(\.delegate.addressSelected)
  }

  func test_confirmSelection_withoutSelection_isNoop() async {
    let store = TestStore(initialState: AddressPickerFeature.State()) {
      AddressPickerFeature()
    }
    await store.send(.confirmSelection)
    // No delegate received.
  }

  func test_dismissTapped_emitsDismissed() async {
    let store = TestStore(initialState: AddressPickerFeature.State()) {
      AddressPickerFeature()
    }

    await store.send(.dismissTapped)
    await store.receive(\.delegate.dismissed)
  }

  // MARK: - Add new address

  func test_startAddingNew_opensEmptyDraftWithMNRegion() async {
    let store = TestStore(initialState: AddressPickerFeature.State()) {
      AddressPickerFeature()
    }

    await store.send(.startAddingNew) {
      $0.draft = AddressPickerFeature.NewAddressDraft()
    }
    XCTAssertEqual(store.state.draft?.region, "MN")
  }

  func test_cancelAddingNew_clearsDraft() async {
    let store = TestStore(
      initialState: AddressPickerFeature.State(
        draft: AddressPickerFeature.NewAddressDraft(line1: "100 Main")
      )
    ) {
      AddressPickerFeature()
    }

    await store.send(.cancelAddingNew) {
      $0.draft = nil
    }
  }

  func test_updateField_mutatesDraft() async {
    let store = TestStore(
      initialState: AddressPickerFeature.State(
        draft: AddressPickerFeature.NewAddressDraft()
      )
    ) {
      AddressPickerFeature()
    }

    await store.send(.updateLine1("100 Main St")) {
      $0.draft?.line1 = "100 Main St"
    }
    await store.send(.updateCity("Minneapolis")) {
      $0.draft?.city = "Minneapolis"
    }
    await store.send(.updatePostalCode("55401")) {
      $0.draft?.postalCode = "55401"
    }
    await store.send(.toggleSetAsDefault(true)) {
      $0.draft?.setAsDefault = true
    }
    XCTAssertTrue(store.state.canSubmitDraft)
  }

  func test_saveDraftTapped_geocodesThenCreatesAndSelects() async {
    let completedDraft = AddressPickerFeature.NewAddressDraft(
      label: "Home",
      line1: "100 Main St",
      city: "Minneapolis",
      region: "MN",
      postalCode: "55401",
      setAsDefault: true
    )
    let geocoded = Coordinate(latitude: 44.9778, longitude: -93.2650)
    let createdAddress = makeAddress(isDefault: true)
    let geocodeQueryRecorder = QueryRecorder()
    let createRecorder = CreateRecorder()

    let store = TestStore(
      initialState: AddressPickerFeature.State(draft: completedDraft)
    ) {
      AddressPickerFeature()
    } withDependencies: {
      $0.geocodingClient.geocode = { query in
        await geocodeQueryRecorder.record(query)
        return geocoded
      }
      $0.addressAPIClient.createAddress = { body in
        await createRecorder.record(body)
        return createdAddress
      }
    }

    await store.send(.saveDraftTapped) {
      $0.isGeocoding = true
    }
    await store.receive(\.geocodeCompleted.success) {
      $0.isGeocoding = false
      $0.isCreating = true
    }
    await store.receive(\.addressCreated.success) {
      $0.isCreating = false
      $0.addresses = [createdAddress]
      $0.selectedAddressId = createdAddress.id
      $0.draft = nil
    }
    await store.receive(\.delegate.addressSelected)

    let queries = await geocodeQueryRecorder.calls
    XCTAssertEqual(queries.count, 1)
    XCTAssertEqual(queries.first?.line1, "100 Main St")
    XCTAssertEqual(queries.first?.postalCode, "55401")

    let creates = await createRecorder.calls
    XCTAssertEqual(creates.count, 1)
    XCTAssertEqual(creates.first?.latitude, geocoded.latitude)
    XCTAssertEqual(creates.first?.longitude, geocoded.longitude)
    XCTAssertEqual(creates.first?.setAsDefault, true)
  }

  func test_saveDraftTapped_demotesPreviousDefaultWhenNewIsDefault() async {
    let oldDefault = makeAddress(isDefault: true)
    let completedDraft = AddressPickerFeature.NewAddressDraft(
      line1: "200 New Ave",
      city: "Minneapolis",
      region: "MN",
      postalCode: "55402",
      setAsDefault: true
    )
    let geocoded = Coordinate(latitude: 44.9, longitude: -93.2)
    let newDefault = makeAddress(isDefault: true)

    let store = TestStore(
      initialState: AddressPickerFeature.State(
        addresses: [oldDefault],
        selectedAddressId: oldDefault.id,
        draft: completedDraft
      )
    ) {
      AddressPickerFeature()
    } withDependencies: {
      $0.geocodingClient.geocode = { _ in geocoded }
      $0.addressAPIClient.createAddress = { _ in newDefault }
    }

    await store.send(.saveDraftTapped) {
      $0.isGeocoding = true
    }
    await store.receive(\.geocodeCompleted.success) {
      $0.isGeocoding = false
      $0.isCreating = true
    }
    let demotedOld = UserAddress(
      id: oldDefault.id,
      label: oldDefault.label,
      line1: oldDefault.line1,
      line2: oldDefault.line2,
      city: oldDefault.city,
      region: oldDefault.region,
      postalCode: oldDefault.postalCode,
      country: oldDefault.country,
      location: oldDefault.location,
      isDefault: false,
      isValidated: oldDefault.isValidated,
      validatedAt: oldDefault.validatedAt,
      deliveryInstructions: oldDefault.deliveryInstructions,
      createdAt: oldDefault.createdAt,
      updatedAt: oldDefault.updatedAt
    )
    await store.receive(\.addressCreated.success) {
      $0.isCreating = false
      $0.addresses = [newDefault, demotedOld]
      $0.selectedAddressId = newDefault.id
      $0.draft = nil
    }
    await store.receive(\.delegate.addressSelected)
  }

  func test_saveDraftTapped_geocodeFailure_clearsBusyAndShowsError() async {
    let completedDraft = AddressPickerFeature.NewAddressDraft(
      line1: "100 Main St",
      city: "Minneapolis",
      region: "MN",
      postalCode: "55401"
    )

    let store = TestStore(
      initialState: AddressPickerFeature.State(draft: completedDraft)
    ) {
      AddressPickerFeature()
    } withDependencies: {
      $0.geocodingClient.geocode = { _ in throw GeocodingError.notFound }
    }

    await store.send(.saveDraftTapped) {
      $0.isGeocoding = true
    }
    await store.receive(\.geocodeCompleted.failure) {
      $0.isGeocoding = false
      $0.error = "We couldn't find that address. Double-check the street and ZIP."
    }
  }

  func test_saveDraftTapped_createFailure_clearsBusyAndShowsError() async {
    let completedDraft = AddressPickerFeature.NewAddressDraft(
      line1: "100 Main St",
      city: "Minneapolis",
      region: "MN",
      postalCode: "55401"
    )

    let store = TestStore(
      initialState: AddressPickerFeature.State(draft: completedDraft)
    ) {
      AddressPickerFeature()
    } withDependencies: {
      $0.geocodingClient.geocode = { _ in Coordinate(latitude: 44.9778, longitude: -93.2650) }
      $0.addressAPIClient.createAddress = { _ in
        throw AddressAPIError.unimplemented("createAddress")
      }
    }

    await store.send(.saveDraftTapped) {
      $0.isGeocoding = true
    }
    await store.receive(\.geocodeCompleted.success) {
      $0.isGeocoding = false
      $0.isCreating = true
    }
    await store.receive(\.addressCreated.failure) {
      $0.isCreating = false
      $0.error = String(describing: AddressAPIError.unimplemented("createAddress"))
    }
  }

  func test_saveDraftTapped_incompleteDraft_isNoop() async {
    let incomplete = AddressPickerFeature.NewAddressDraft(
      line1: "100 Main St"
      // city / region / postal missing
    )

    let store = TestStore(
      initialState: AddressPickerFeature.State(draft: incomplete)
    ) {
      AddressPickerFeature()
    }

    await store.send(.saveDraftTapped)
    XCTAssertFalse(store.state.isGeocoding)
    XCTAssertFalse(store.state.isCreating)
  }
}

// MARK: - Helpers

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

// MARK: - Recorders

private actor QueryRecorder {
  private(set) var calls: [GeocodingClient.GeocodeQuery] = []

  func record(_ query: GeocodingClient.GeocodeQuery) {
    calls.append(query)
  }
}

private actor CreateRecorder {
  private(set) var calls: [CreateAddressRequestDTO] = []

  func record(_ body: CreateAddressRequestDTO) {
    calls.append(body)
  }
}
