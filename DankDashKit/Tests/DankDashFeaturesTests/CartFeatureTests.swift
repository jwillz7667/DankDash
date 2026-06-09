import XCTest
import Foundation
import ComposableArchitecture
import DankDashDomain
@testable import DankDashFeatures

@MainActor
final class CartFeatureTests: XCTestCase {
  // MARK: - Promotion

  func test_promotion_threeLines_createsCartThenAddsThenValidates() async {
    let dispensaryId = UUID()
    let address = makeAddress(isDefault: true)
    let l1 = makeDraftLine()
    let l2 = makeDraftLine()
    let l3 = makeDraftLine()
    let draft = LocalCartDraft(lines: [l1, l2, l3])
    let referenceDate = Date(timeIntervalSinceReferenceDate: 0)
    let cartId = UUID()
    let emptyCart = makeCart(id: cartId, items: [], expiresAt: referenceDate.addingTimeInterval(1_800))
    let fullCart = makeCart(
      id: cartId,
      items: [
        makeCartItem(listingId: l1.listingId),
        makeCartItem(listingId: l2.listingId),
        makeCartItem(listingId: l3.listingId)
      ],
      expiresAt: referenceDate.addingTimeInterval(1_800)
    )
    let evaluation = makeEvaluation(passed: true)
    let createRecorder = ArgsRecorder<UUID>()
    let addRecorder = AddItemRecorder()
    let validateRecorder = ArgsRecorder<UUID>()

    let store = TestStore(
      initialState: CartFeature.State(
        draft: draft,
        dispensaryId: dispensaryId,
        availableAddresses: [address],
        selectedAddressId: address.id
      )
    ) {
      CartFeature()
    } withDependencies: {
      $0.date = .constant(referenceDate)
      $0.cartAPIClient.createCart = { id in
        await createRecorder.record(id)
        return emptyCart
      }
      $0.cartAPIClient.addItem = { _, listingId, quantity in
        await addRecorder.record(listingId: listingId, quantity: quantity)
        return fullCart
      }
      $0.cartAPIClient.validate = { cartId, _ in
        await validateRecorder.record(cartId)
        return evaluation
      }
    }

    await store.send(.promotionRequested) {
      $0.isPromoting = true
    }
    await store.receive(\.cartCreated.success) {
      $0.serverCart = emptyCart
      $0.expirySecondsRemaining = 1_800
    }
    await store.receive(\.promotionFinished.success) {
      $0.isPromoting = false
      $0.serverCart = fullCart
      $0.draft = LocalCartDraft()
      $0.expirySecondsRemaining = 1_800
    }
    await store.receive(\.validateFired) {
      $0.isValidating = true
    }
    await store.receive(\.validationCompleted.success) {
      $0.isValidating = false
      $0.evaluation = evaluation
    }

    let createCount = await createRecorder.count
    let addCount = await addRecorder.count
    let validateCount = await validateRecorder.count
    XCTAssertEqual(createCount, 1)
    XCTAssertEqual(addCount, 3)
    XCTAssertEqual(validateCount, 1)
  }

  func test_promotion_emptyDraft_noEffect() async {
    let store = TestStore(
      initialState: CartFeature.State(
        draft: LocalCartDraft(),
        dispensaryId: UUID()
      )
    ) {
      CartFeature()
    }

    await store.send(.promotionRequested)
    // Nothing happens — guard rejects the empty draft.
  }

  // MARK: - Validate over-limit

  func test_validateOverLimit_blocksCheckout() async {
    let referenceDate = Date(timeIntervalSinceReferenceDate: 0)
    let cart = makeCart(items: [makeCartItem()], expiresAt: referenceDate.addingTimeInterval(1_800))
    let address = makeAddress()
    let failing = makeEvaluation(
      passed: false,
      rules: [
        RuleResult(
          rule: .perTransactionLimit,
          passed: false,
          details: AnyValue.object(["flowerGramsOver": .double(12.3)])
        )
      ]
    )

    let store = TestStore(
      initialState: CartFeature.State(
        serverCart: cart,
        availableAddresses: [address],
        selectedAddressId: address.id
      )
    ) {
      CartFeature()
    } withDependencies: {
      $0.date = .constant(referenceDate)
      $0.cartAPIClient.validate = { _, _ in failing }
    }

    await store.send(.validateFired) {
      $0.isValidating = true
    }
    await store.receive(\.validationCompleted.success) {
      $0.isValidating = false
      $0.evaluation = failing
    }

    XCTAssertFalse(store.state.canCheckout, "Failing evaluation must disable the CTA")
  }

  // MARK: - Quantity stepper debounce

  func test_quantityStepped_debouncedPatch_singleNetworkCall() async {
    let referenceDate = Date(timeIntervalSinceReferenceDate: 0)
    let clock = TestClock()
    let userId = UUID()
    let dispensaryId = UUID()
    let cartId = UUID()
    let item = makeCartItem(quantity: 1, unitPriceCents: 1_500)
    let cart = makeCart(
      id: cartId,
      userId: userId,
      dispensaryId: dispensaryId,
      items: [item],
      subtotalCents: 1_500,
      expiresAt: referenceDate.addingTimeInterval(1_800)
    )
    let address = makeAddress()
    let evaluation = makeEvaluation(passed: true)
    let patchRecorder = PatchRecorder()

    let store = TestStore(
      initialState: CartFeature.State(
        serverCart: cart,
        availableAddresses: [address],
        selectedAddressId: address.id
      )
    ) {
      CartFeature()
    } withDependencies: {
      $0.continuousClock = clock
      $0.date = .constant(referenceDate)
      $0.cartAPIClient.patchItem = { _, itemId, quantity in
        await patchRecorder.record(itemId: itemId, quantity: quantity)
        let synced = makeCartItem(
          id: itemId,
          listingId: item.listingId,
          quantity: quantity,
          unitPriceCents: item.unitPriceCents
        )
        return makeCart(
          id: cartId,
          userId: userId,
          dispensaryId: dispensaryId,
          items: [synced],
          subtotalCents: synced.lineSubtotalCents,
          expiresAt: cart.expiresAt
        )
      }
      $0.cartAPIClient.validate = { _, _ in evaluation }
    }

    // Two rapid stepper events under 350ms. Only the most recent should
    // actually fire a PATCH once the debounce window elapses.
    await store.send(.quantityStepped(itemId: item.id, quantity: 2)) {
      $0.serverCart = makeCart(
        id: cartId,
        userId: userId,
        dispensaryId: dispensaryId,
        items: [makeCartItem(
          id: item.id,
          listingId: item.listingId,
          quantity: 2,
          unitPriceCents: item.unitPriceCents
        )],
        subtotalCents: 3_000,
        expiresAt: cart.expiresAt
      )
      $0.evaluation = nil
    }
    await clock.advance(by: .milliseconds(100))
    await store.send(.quantityStepped(itemId: item.id, quantity: 3)) {
      $0.serverCart = makeCart(
        id: cartId,
        userId: userId,
        dispensaryId: dispensaryId,
        items: [makeCartItem(
          id: item.id,
          listingId: item.listingId,
          quantity: 3,
          unitPriceCents: item.unitPriceCents
        )],
        subtotalCents: 4_500,
        expiresAt: cart.expiresAt
      )
      $0.evaluation = nil
    }
    await clock.advance(by: .milliseconds(350))
    await store.receive(\.syncCartFired)
    let syncedCart = makeCart(
      id: cartId,
      userId: userId,
      dispensaryId: dispensaryId,
      items: [makeCartItem(
        id: item.id,
        listingId: item.listingId,
        quantity: 3,
        unitPriceCents: item.unitPriceCents
      )],
      subtotalCents: 4_500,
      expiresAt: cart.expiresAt
    )
    await store.receive(\.cartSynced.success) {
      $0.serverCart = syncedCart
      $0.expirySecondsRemaining = 1_800
    }
    await store.receive(\.validateRequested)
    await clock.advance(by: .milliseconds(350))
    await store.receive(\.validateFired) {
      $0.isValidating = true
    }
    await store.receive(\.validationCompleted.success) {
      $0.isValidating = false
      $0.evaluation = evaluation
    }

    let calls = await patchRecorder.calls
    XCTAssertEqual(calls.count, 1, "Debounce should collapse two rapid steps into one PATCH")
    XCTAssertEqual(calls.first?.quantity, 3)
  }

  // MARK: - Expiry

  func test_expiryTick_updatesSecondsRemaining() async {
    let referenceDate = Date(timeIntervalSinceReferenceDate: 0)
    let cart = makeCart(expiresAt: referenceDate.addingTimeInterval(600))

    let store = TestStore(
      initialState: CartFeature.State(
        serverCart: cart,
        expirySecondsRemaining: 1_800
      )
    ) {
      CartFeature()
    } withDependencies: {
      $0.date = .constant(referenceDate)
    }

    await store.send(.expiryTick) {
      $0.expirySecondsRemaining = 600
    }
  }

  func test_expiryTick_pastExpiresAt_transitionsToCartExpired() async {
    let referenceDate = Date(timeIntervalSinceReferenceDate: 0)
    let expired = makeCart(expiresAt: referenceDate.addingTimeInterval(-1))
    let stillSeededDraft = LocalCartDraft(lines: [makeDraftLine()])

    let store = TestStore(
      initialState: CartFeature.State(
        draft: stillSeededDraft,
        serverCart: expired,
        evaluation: makeEvaluation(passed: true),
        expirySecondsRemaining: 0
      )
    ) {
      CartFeature()
    } withDependencies: {
      $0.date = .constant(referenceDate)
    }

    await store.send(.expiryTick)
    await store.receive(\.cartExpired) {
      $0.serverCart = nil
      $0.evaluation = nil
      $0.expirySecondsRemaining = nil
      $0.error = "Your cart expired. Re-add items to continue."
    }

    XCTAssertEqual(
      store.state.draft, stillSeededDraft,
      "Expired cart must NOT touch the in-memory draft"
    )
  }

  // MARK: - Checkout delegate

  func test_checkoutTapped_delegatesCheckoutRequested() async {
    let referenceDate = Date(timeIntervalSinceReferenceDate: 0)
    let cart = makeCart(items: [makeCartItem()], expiresAt: referenceDate.addingTimeInterval(1_800))
    let address = makeAddress()
    let passing = makeEvaluation(passed: true)

    let store = TestStore(
      initialState: CartFeature.State(
        serverCart: cart,
        availableAddresses: [address],
        selectedAddressId: address.id,
        evaluation: passing
      )
    ) {
      CartFeature()
    } withDependencies: {
      $0.date = .constant(referenceDate)
    }

    XCTAssertTrue(store.state.canCheckout)
    await store.send(.checkoutTapped)
    await store.receive(\.delegate.checkoutRequested)
  }

  func test_checkoutTapped_evaluationFailed_doesNothing() async {
    let referenceDate = Date(timeIntervalSinceReferenceDate: 0)
    let cart = makeCart(items: [makeCartItem()], expiresAt: referenceDate.addingTimeInterval(1_800))
    let address = makeAddress()
    let failing = makeEvaluation(passed: false)

    let store = TestStore(
      initialState: CartFeature.State(
        serverCart: cart,
        availableAddresses: [address],
        selectedAddressId: address.id,
        evaluation: failing
      )
    ) {
      CartFeature()
    } withDependencies: {
      $0.date = .constant(referenceDate)
    }

    XCTAssertFalse(store.state.canCheckout)
    await store.send(.checkoutTapped)
    // No delegate received — the canCheckout guard rejected the tap.
  }

  // MARK: - Payment-bypass capabilities + test order

  func test_capabilitiesResponse_success_setsFlag() async {
    let store = TestStore(initialState: CartFeature.State()) {
      CartFeature()
    }

    await store.send(.capabilitiesResponse(.success(true))) {
      $0.paymentBypassEnabled = true
    }
  }

  func test_capabilitiesResponse_failure_keepsBypassHidden() async {
    let store = TestStore(
      initialState: CartFeature.State(paymentBypassEnabled: true)
    ) {
      CartFeature()
    }

    await store.send(.capabilitiesResponse(.failure(EquatableError(message: "offline")))) {
      $0.paymentBypassEnabled = false
    }
  }

  func test_placeTestOrderTapped_bypassEnabled_delegatesTestOrderPlaced() async {
    let referenceDate = Date(timeIntervalSinceReferenceDate: 0)
    let cart = makeCart(items: [makeCartItem()], expiresAt: referenceDate.addingTimeInterval(1_800))
    let address = makeAddress()
    let passing = makeEvaluation(passed: true)
    let orderId = UUID()
    let checkoutRecorder = CheckoutArgsRecorder()

    let store = TestStore(
      initialState: CartFeature.State(
        serverCart: cart,
        availableAddresses: [address],
        selectedAddressId: address.id,
        evaluation: passing,
        paymentBypassEnabled: true
      )
    ) {
      CartFeature()
    } withDependencies: {
      $0.date = .constant(referenceDate)
      $0.checkoutAPIClient.checkout = { cartId, addressId, tip in
        await checkoutRecorder.record(cartId: cartId, addressId: addressId, tip: tip)
        return orderId
      }
    }

    XCTAssertTrue(store.state.canPlaceTestOrder)
    await store.send(.placeTestOrderTapped) {
      $0.isPlacingTestOrder = true
    }
    await store.receive(\.testOrderResponse.success) {
      $0.isPlacingTestOrder = false
    }
    await store.receive(\.delegate.testOrderPlaced)

    let recorded = await checkoutRecorder.calls
    XCTAssertEqual(recorded.count, 1)
    XCTAssertEqual(recorded.first?.cartId, cart.id)
    XCTAssertEqual(recorded.first?.addressId, address.id)
    XCTAssertEqual(recorded.first?.tip, 0)
  }

  func test_placeTestOrderTapped_bypassDisabled_doesNothing() async {
    let referenceDate = Date(timeIntervalSinceReferenceDate: 0)
    let cart = makeCart(items: [makeCartItem()], expiresAt: referenceDate.addingTimeInterval(1_800))
    let address = makeAddress()
    let passing = makeEvaluation(passed: true)

    let store = TestStore(
      initialState: CartFeature.State(
        serverCart: cart,
        availableAddresses: [address],
        selectedAddressId: address.id,
        evaluation: passing,
        paymentBypassEnabled: false
      )
    ) {
      CartFeature()
    } withDependencies: {
      $0.date = .constant(referenceDate)
    }

    XCTAssertFalse(store.state.canPlaceTestOrder)
    await store.send(.placeTestOrderTapped)
    // No effect — the paymentBypassEnabled guard rejected the tap.
  }

  func test_placeTestOrderTapped_failure_setsErrorAndClearsPlacing() async {
    let referenceDate = Date(timeIntervalSinceReferenceDate: 0)
    let cart = makeCart(items: [makeCartItem()], expiresAt: referenceDate.addingTimeInterval(1_800))
    let address = makeAddress()
    let passing = makeEvaluation(passed: true)

    let store = TestStore(
      initialState: CartFeature.State(
        serverCart: cart,
        availableAddresses: [address],
        selectedAddressId: address.id,
        evaluation: passing,
        paymentBypassEnabled: true
      )
    ) {
      CartFeature()
    } withDependencies: {
      $0.date = .constant(referenceDate)
      $0.checkoutAPIClient.checkout = { _, _, _ in
        struct StubError: LocalizedError { var errorDescription: String? { "checkout failed" } }
        throw StubError()
      }
    }

    await store.send(.placeTestOrderTapped) {
      $0.isPlacingTestOrder = true
    }
    await store.receive(\.testOrderResponse.failure) {
      $0.isPlacingTestOrder = false
      $0.error = "Couldn't place test order: checkout failed"
    }
  }

  // MARK: - Address selection

  func test_selectAddress_withServerCart_firesValidate() async {
    let referenceDate = Date(timeIntervalSinceReferenceDate: 0)
    let clock = TestClock()
    let a = makeAddress(isDefault: true)
    let b = makeAddress(isDefault: false)
    let cart = makeCart(items: [makeCartItem()], expiresAt: referenceDate.addingTimeInterval(1_800))
    let passing = makeEvaluation(passed: true)

    let store = TestStore(
      initialState: CartFeature.State(
        serverCart: cart,
        availableAddresses: [a, b],
        selectedAddressId: a.id
      )
    ) {
      CartFeature()
    } withDependencies: {
      $0.continuousClock = clock
      $0.date = .constant(referenceDate)
      $0.cartAPIClient.validate = { _, _ in passing }
    }

    await store.send(.selectAddress(b.id)) {
      $0.selectedAddressId = b.id
    }
    await store.receive(\.validateRequested)
    await clock.advance(by: .milliseconds(350))
    await store.receive(\.validateFired) {
      $0.isValidating = true
    }
    await store.receive(\.validationCompleted.success) {
      $0.isValidating = false
      $0.evaluation = passing
    }
  }

  func test_selectAddress_unknownId_isIgnored() async {
    let store = TestStore(
      initialState: CartFeature.State(
        availableAddresses: [makeAddress()]
      )
    ) {
      CartFeature()
    }

    await store.send(.selectAddress(UUID()))
    // Unknown id rejected by guard — no state change.
  }

  // MARK: - Address picker

  func test_openAddressPickerTapped_mountsPickerWithCurrentSelection() async {
    let a = makeAddress(isDefault: true)
    let b = makeAddress(isDefault: false)
    let store = TestStore(
      initialState: CartFeature.State(
        availableAddresses: [a, b],
        selectedAddressId: b.id
      )
    ) {
      CartFeature()
    }
    store.exhaustivity = .off

    await store.send(.openAddressPickerTapped) {
      $0.addressPicker = AddressPickerFeature.State(
        addresses: [a, b],
        selectedAddressId: b.id
      )
    }
  }

  func test_addressPickerDelegateSelected_picksUpAndFiresValidate() async {
    let referenceDate = Date(timeIntervalSinceReferenceDate: 0)
    let clock = TestClock()
    let a = makeAddress(isDefault: true)
    let cart = makeCart(items: [makeCartItem()], expiresAt: referenceDate.addingTimeInterval(1_800))
    let passing = makeEvaluation(passed: true)

    let store = TestStore(
      initialState: CartFeature.State(
        serverCart: cart,
        availableAddresses: [a],
        selectedAddressId: a.id,
        addressPicker: AddressPickerFeature.State(addresses: [a], selectedAddressId: a.id)
      )
    ) {
      CartFeature()
    } withDependencies: {
      $0.continuousClock = clock
      $0.date = .constant(referenceDate)
      $0.cartAPIClient.validate = { _, _ in passing }
    }
    store.exhaustivity = .off

    await store.send(.addressPicker(.delegate(.addressSelected(a)))) {
      $0.addressPicker = nil
    }
    await store.receive(\.addressPicked)
    await clock.advance(by: .milliseconds(350))
    await store.receive(\.validateFired)
    await store.receive(\.validationCompleted.success)
  }

  func test_addressPickerDelegateDismissed_unmountsPicker() async {
    let store = TestStore(
      initialState: CartFeature.State(
        addressPicker: AddressPickerFeature.State()
      )
    ) {
      CartFeature()
    }
    store.exhaustivity = .off

    await store.send(.addressPicker(.delegate(.dismissed))) {
      $0.addressPicker = nil
    }
  }

  func test_addressPicked_unknownNewAddress_isInsertedAndSelected() async {
    let referenceDate = Date(timeIntervalSinceReferenceDate: 0)
    let clock = TestClock()
    let existing = makeAddress(isDefault: true)
    let fresh = makeAddress(isDefault: false)
    let cart = makeCart(items: [makeCartItem()], expiresAt: referenceDate.addingTimeInterval(1_800))
    let passing = makeEvaluation(passed: true)

    let store = TestStore(
      initialState: CartFeature.State(
        serverCart: cart,
        availableAddresses: [existing],
        selectedAddressId: existing.id
      )
    ) {
      CartFeature()
    } withDependencies: {
      $0.continuousClock = clock
      $0.date = .constant(referenceDate)
      $0.cartAPIClient.validate = { _, _ in passing }
    }
    store.exhaustivity = .off

    await store.send(.addressPicked(fresh)) {
      $0.availableAddresses = [fresh, existing]
      $0.selectedAddressId = fresh.id
    }
    await store.receive(\.validateRequested)
    await clock.advance(by: .milliseconds(350))
    await store.receive(\.validateFired)
    await store.receive(\.validationCompleted.success)
  }

  func test_addressPicked_withoutServerCart_skipsValidate() async {
    let fresh = makeAddress(isDefault: false)
    let store = TestStore(
      initialState: CartFeature.State()
    ) {
      CartFeature()
    }

    await store.send(.addressPicked(fresh)) {
      $0.availableAddresses = [fresh]
      $0.selectedAddressId = fresh.id
    }
    // No serverCart → guard skips validate; no further actions to receive.
  }
}

// MARK: - Free-function helpers
//
// Lifted out of the @MainActor `CartFeatureTests` class so they're safe
// to invoke from inside Sendable dependency closures (which run on the
// dependency's actor, not main).

private func makeCart(
  id: UUID = UUID(),
  userId: UUID = UUID(),
  dispensaryId: UUID = UUID(),
  items: [CartItem] = [],
  subtotalCents: Int? = nil,
  expiresAt: Date = Date(timeIntervalSinceReferenceDate: 100_000)
) -> Cart {
  Cart(
    id: id,
    userId: userId,
    dispensaryId: dispensaryId,
    items: items,
    subtotalCents: subtotalCents ?? items.reduce(0) { $0 + $1.lineSubtotalCents },
    expiresAt: expiresAt,
    createdAt: Date(timeIntervalSinceReferenceDate: 0),
    updatedAt: Date(timeIntervalSinceReferenceDate: 0)
  )
}

private func makeCartItem(
  id: UUID = UUID(),
  listingId: UUID = UUID(),
  quantity: Int = 1,
  unitPriceCents: Int = 1_500
) -> CartItem {
  CartItem(
    id: id,
    listingId: listingId,
    quantity: quantity,
    unitPriceCents: unitPriceCents,
    lineSubtotalCents: unitPriceCents * quantity,
    createdAt: Date(timeIntervalSinceReferenceDate: 0),
    updatedAt: Date(timeIntervalSinceReferenceDate: 0)
  )
}

private func makeDraftLine() -> LocalCartDraft.Line {
  LocalCartDraft.Line(
    listingId: UUID(),
    productId: UUID(),
    productName: "Sour Diesel",
    brand: "Brand",
    priceCents: 1_500,
    quantity: 1,
    maxAvailable: 10
  )
}

private func makeAddress(isDefault: Bool = false) -> UserAddress {
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

private func makeEvaluation(
  passed: Bool,
  rules: [RuleResult] = []
) -> ComplianceEvaluation {
  ComplianceEvaluation(
    passed: passed,
    rules: rules,
    cartTotals: .zero,
    limits: ComplianceLimits(
      flowerGramsMax: Decimal(string: "56.7")!,
      concentrateGramsMax: 8,
      edibleThcMgMax: 800
    ),
    evaluatedAt: Date(timeIntervalSinceReferenceDate: 0),
    evaluationVersion: "test-1"
  )
}

// MARK: - Call recorders

private actor ArgsRecorder<A: Sendable> {
  private(set) var calls: [A] = []

  func record(_ args: A) {
    calls.append(args)
  }

  var count: Int { calls.count }
}

private actor AddItemRecorder {
  private(set) var calls: [(listingId: UUID, quantity: Int)] = []

  func record(listingId: UUID, quantity: Int) {
    calls.append((listingId, quantity))
  }

  var count: Int { calls.count }
}

private actor PatchRecorder {
  private(set) var calls: [(itemId: UUID, quantity: Int)] = []

  func record(itemId: UUID, quantity: Int) {
    calls.append((itemId, quantity))
  }
}

private actor CheckoutArgsRecorder {
  private(set) var calls: [(cartId: UUID, addressId: UUID, tip: Int)] = []

  func record(cartId: UUID, addressId: UUID, tip: Int) {
    calls.append((cartId, addressId, tip))
  }
}
