import XCTest
import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

@MainActor
final class AddressFormFeatureTests: XCTestCase {
  // MARK: - Initialization

  func test_addMode_initializesEmptyDraftWithMNRegion() {
    let state = AddressFormFeature.State(mode: .add)
    XCTAssertEqual(state.region, "MN")
    XCTAssertEqual(state.line1, "")
    XCTAssertFalse(state.setAsDefault)
    XCTAssertFalse(state.isEditing)
    XCTAssertFalse(state.isEditingDefault)
    XCTAssertFalse(state.isComplete)
  }

  func test_editMode_hydratesFromAddress() {
    let address = makeAddress(isDefault: true, label: "Home", line2: "Apt 4")
    let state = AddressFormFeature.State(mode: .edit(address))
    XCTAssertEqual(state.label, "Home")
    XCTAssertEqual(state.line1, address.line1)
    XCTAssertEqual(state.line2, "Apt 4")
    XCTAssertEqual(state.city, address.city)
    XCTAssertEqual(state.region, address.region)
    XCTAssertEqual(state.postalCode, address.postalCode)
    XCTAssertTrue(state.setAsDefault, "editing the default seeds the toggle on")
    XCTAssertTrue(state.isEditing)
    XCTAssertTrue(state.isEditingDefault)
    XCTAssertTrue(state.isComplete)
  }

  func test_editMode_nilOptionalsHydrateAsEmptyStrings() {
    let address = makeAddress(isDefault: false, label: nil, line2: nil)
    let state = AddressFormFeature.State(mode: .edit(address))
    XCTAssertEqual(state.label, "")
    XCTAssertEqual(state.line2, "")
    XCTAssertFalse(state.setAsDefault)
    XCTAssertFalse(state.isEditingDefault)
  }

  // MARK: - Field editing

  func test_updateFields_mutateDraft() async {
    let store = TestStore(initialState: AddressFormFeature.State(mode: .add)) {
      AddressFormFeature()
    }
    await store.send(.updateLine1("100 Main St")) { $0.line1 = "100 Main St" }
    await store.send(.updateCity("Minneapolis")) { $0.city = "Minneapolis" }
    await store.send(.updatePostalCode("55401")) { $0.postalCode = "55401" }
    await store.send(.updateLabel("Home")) { $0.label = "Home" }
    await store.send(.toggleSetAsDefault(true)) { $0.setAsDefault = true }
    XCTAssertTrue(store.state.canSave)
  }

  func test_toggleSetAsDefault_whenEditingDefault_isNoop() async {
    let address = makeAddress(isDefault: true)
    let store = TestStore(initialState: AddressFormFeature.State(mode: .edit(address))) {
      AddressFormFeature()
    }
    // The current default can't be un-defaulted from the edit form.
    await store.send(.toggleSetAsDefault(false))
    XCTAssertTrue(store.state.setAsDefault)
  }

  // MARK: - Save: add (geocode → create)

  func test_addMode_save_geocodesThenCreatesAndDelegates() async {
    let geocoded = Coordinate(latitude: 44.9778, longitude: -93.2650)
    let created = makeAddress(isDefault: true)
    let createRecorder = CreateRecorder()

    let store = TestStore(
      initialState: AddressFormFeature.State(mode: .add)
    ) {
      AddressFormFeature()
    } withDependencies: {
      $0.geocodingClient.geocode = { _ in geocoded }
      $0.addressAPIClient.createAddress = { body in
        await createRecorder.record(body)
        return created
      }
    }

    await fillRequiredFields(store, setAsDefault: true)

    await store.send(.saveTapped) { $0.isGeocoding = true }
    await store.receive(\.geocodeCompleted.success) {
      $0.isGeocoding = false
      $0.isSaving = true
    }
    await store.receive(\.saved.success) { $0.isSaving = false }
    await store.receive(\.delegate.saved)

    let bodies = await createRecorder.calls
    XCTAssertEqual(bodies.count, 1)
    XCTAssertEqual(bodies.first?.latitude, geocoded.latitude)
    XCTAssertEqual(bodies.first?.longitude, geocoded.longitude)
    XCTAssertEqual(bodies.first?.setAsDefault, true)
  }

  // MARK: - Save: edit (reuse coordinate when lines unchanged)

  func test_editMode_unchangedLines_skipsGeocodeAndReusesCoordinate() async {
    let original = makeAddress(isDefault: false)
    let edited = makeAddress(isDefault: false)
    let editRecorder = EditRecorder()

    let store = TestStore(
      initialState: AddressFormFeature.State(mode: .edit(original))
    ) {
      AddressFormFeature()
    } withDependencies: {
      // Geocoder intentionally left unimplemented — if the reducer called
      // it, the TestStore would receive an unexpected geocodeCompleted and
      // fail. Proving the reuse path means no geocode action at all.
      $0.addressAPIClient.editAddress = { id, body in
        await editRecorder.record(id, body)
        return edited
      }
    }

    // Only change the label — not a geocode-relevant line.
    await store.send(.updateLabel("Renamed")) { $0.label = "Renamed" }

    await store.send(.saveTapped) { $0.isSaving = true }
    await store.receive(\.saved.success) { $0.isSaving = false }
    await store.receive(\.delegate.saved)

    let calls = await editRecorder.calls
    XCTAssertEqual(calls.count, 1)
    XCTAssertEqual(calls.first?.id, original.id)
    XCTAssertEqual(calls.first?.body.latitude, original.location.latitude)
    XCTAssertEqual(calls.first?.body.longitude, original.location.longitude)
    XCTAssertEqual(calls.first?.body.label, "Renamed")
    XCTAssertNil(calls.first?.body.isDefault, "non-promoting edit omits isDefault")
  }

  func test_editMode_changedLine_geocodesBeforeEditing() async {
    let original = makeAddress(isDefault: false)
    let edited = makeAddress(isDefault: false)
    let geocoded = Coordinate(latitude: 45.0, longitude: -93.0)
    let editRecorder = EditRecorder()

    let store = TestStore(
      initialState: AddressFormFeature.State(mode: .edit(original))
    ) {
      AddressFormFeature()
    } withDependencies: {
      $0.geocodingClient.geocode = { _ in geocoded }
      $0.addressAPIClient.editAddress = { id, body in
        await editRecorder.record(id, body)
        return edited
      }
    }

    await store.send(.updateLine1("999 Different Ave")) { $0.line1 = "999 Different Ave" }

    await store.send(.saveTapped) { $0.isGeocoding = true }
    await store.receive(\.geocodeCompleted.success) {
      $0.isGeocoding = false
      $0.isSaving = true
    }
    await store.receive(\.saved.success) { $0.isSaving = false }
    await store.receive(\.delegate.saved)

    let calls = await editRecorder.calls
    XCTAssertEqual(calls.first?.body.latitude, geocoded.latitude)
    XCTAssertEqual(calls.first?.body.longitude, geocoded.longitude)
  }

  func test_editMode_promoteNonDefault_sendsIsDefaultTrue() async {
    let original = makeAddress(isDefault: false)
    let edited = makeAddress(isDefault: true)
    let editRecorder = EditRecorder()

    let store = TestStore(
      initialState: AddressFormFeature.State(mode: .edit(original))
    ) {
      AddressFormFeature()
    } withDependencies: {
      $0.addressAPIClient.editAddress = { id, body in
        await editRecorder.record(id, body)
        return edited
      }
    }

    await store.send(.toggleSetAsDefault(true)) { $0.setAsDefault = true }
    await store.send(.saveTapped) { $0.isSaving = true }
    await store.receive(\.saved.success) { $0.isSaving = false }
    await store.receive(\.delegate.saved)

    let calls = await editRecorder.calls
    XCTAssertEqual(calls.first?.body.isDefault, true, "promoting a non-default edit ships isDefault:true")
  }

  func test_editMode_currentDefault_doesNotResendIsDefault() async {
    let original = makeAddress(isDefault: true)
    let edited = makeAddress(isDefault: true)
    let editRecorder = EditRecorder()

    let store = TestStore(
      initialState: AddressFormFeature.State(mode: .edit(original))
    ) {
      AddressFormFeature()
    } withDependencies: {
      $0.addressAPIClient.editAddress = { id, body in
        await editRecorder.record(id, body)
        return edited
      }
    }

    // setAsDefault is already true (it's the default) but shouldPromote is
    // false — re-sending isDefault:true would be a redundant write.
    await store.send(.saveTapped) { $0.isSaving = true }
    await store.receive(\.saved.success) { $0.isSaving = false }
    await store.receive(\.delegate.saved)

    let calls = await editRecorder.calls
    XCTAssertNil(calls.first?.body.isDefault)
  }

  // MARK: - Failure paths

  func test_save_geocodeFailure_surfacesErrorAndClearsBusy() async {
    let store = TestStore(initialState: AddressFormFeature.State(mode: .add)) {
      AddressFormFeature()
    } withDependencies: {
      $0.geocodingClient.geocode = { _ in throw GeocodingError.notFound }
    }
    await fillRequiredFields(store, setAsDefault: false)

    await store.send(.saveTapped) { $0.isGeocoding = true }
    await store.receive(\.geocodeCompleted.failure) {
      $0.isGeocoding = false
      $0.error = "We couldn't find that address. Double-check the street and ZIP."
    }
  }

  func test_save_createFailure_surfacesErrorAndClearsBusy() async {
    let store = TestStore(initialState: AddressFormFeature.State(mode: .add)) {
      AddressFormFeature()
    } withDependencies: {
      $0.geocodingClient.geocode = { _ in Coordinate(latitude: 44.97, longitude: -93.26) }
      $0.addressAPIClient.createAddress = { _ in
        throw AddressAPIError.unimplemented("createAddress")
      }
    }
    await fillRequiredFields(store, setAsDefault: false)

    await store.send(.saveTapped) { $0.isGeocoding = true }
    await store.receive(\.geocodeCompleted.success) {
      $0.isGeocoding = false
      $0.isSaving = true
    }
    await store.receive(\.saved.failure) {
      $0.isSaving = false
      $0.error = String(describing: AddressAPIError.unimplemented("createAddress"))
    }
  }

  func test_editMode_saveFailure_surfacesErrorAndClearsBusy() async {
    let original = makeAddress(isDefault: false)
    let store = TestStore(
      initialState: AddressFormFeature.State(mode: .edit(original))
    ) {
      AddressFormFeature()
    } withDependencies: {
      // Lines unchanged → reuses the original coordinate, skips the geocoder,
      // and routes straight to editAddress — which throws here. Covers the
      // edit branch of persist(), distinct from the add-mode failure above.
      $0.addressAPIClient.editAddress = { _, _ in
        throw AddressAPIError.unimplemented("editAddress")
      }
    }

    await store.send(.saveTapped) { $0.isSaving = true }
    await store.receive(\.saved.failure) {
      $0.isSaving = false
      $0.error = String(describing: AddressAPIError.unimplemented("editAddress"))
    }
  }

  func test_save_incompleteDraft_isNoop() async {
    let store = TestStore(initialState: AddressFormFeature.State(mode: .add)) {
      AddressFormFeature()
    }
    await store.send(.saveTapped)
    XCTAssertFalse(store.state.isGeocoding)
    XCTAssertFalse(store.state.isSaving)
  }

  func test_cancelTapped_delegatesCancelled() async {
    let store = TestStore(initialState: AddressFormFeature.State(mode: .add)) {
      AddressFormFeature()
    }
    await store.send(.cancelTapped)
    await store.receive(\.delegate.cancelled)
  }

  // MARK: - Helpers

  private func fillRequiredFields(
    _ store: TestStoreOf<AddressFormFeature>,
    setAsDefault: Bool
  ) async {
    await store.send(.updateLine1("100 Main St")) { $0.line1 = "100 Main St" }
    await store.send(.updateCity("Minneapolis")) { $0.city = "Minneapolis" }
    await store.send(.updatePostalCode("55401")) { $0.postalCode = "55401" }
    if setAsDefault {
      await store.send(.toggleSetAsDefault(true)) { $0.setAsDefault = true }
    }
  }
}

// MARK: - Fixtures

private func makeAddress(
  isDefault: Bool,
  label: String? = "Home",
  line2: String? = nil
) -> UserAddress {
  UserAddress(
    id: UUID(),
    label: label,
    line1: "100 Main St",
    line2: line2,
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

private actor CreateRecorder {
  private(set) var calls: [CreateAddressRequestDTO] = []
  func record(_ body: CreateAddressRequestDTO) { calls.append(body) }
}

private actor EditRecorder {
  private(set) var calls: [(id: UUID, body: EditAddressRequestDTO)] = []
  func record(_ id: UUID, _ body: EditAddressRequestDTO) { calls.append((id, body)) }
}
