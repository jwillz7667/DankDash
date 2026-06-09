import XCTest
import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

@MainActor
final class PaymentMethodsFeatureTests: XCTestCase {
  // MARK: - Load

  func test_onAppear_loadsMethods() async {
    let a = makeMethod(isDefault: true)
    let b = makeMethod(isDefault: false)
    let store = TestStore(initialState: PaymentMethodsFeature.State()) {
      PaymentMethodsFeature()
    } withDependencies: {
      $0.paymentMethodAPIClient.listPaymentMethods = { [a, b] }
    }

    await store.send(.onAppear) { $0.isLoading = true }
    await store.receive(\.paymentMethodsLoaded.success) {
      $0.isLoading = false
      $0.paymentMethods = [a, b]
    }
  }

  func test_onAppear_whenAlreadyLoaded_isNoop() async {
    let a = makeMethod(isDefault: true)
    let store = TestStore(initialState: PaymentMethodsFeature.State(paymentMethods: [a])) {
      PaymentMethodsFeature()
    }
    await store.send(.onAppear)
  }

  func test_onAppear_failure_surfacesError() async {
    let store = TestStore(initialState: PaymentMethodsFeature.State()) {
      PaymentMethodsFeature()
    } withDependencies: {
      $0.paymentMethodAPIClient.listPaymentMethods = {
        throw PaymentMethodAPIError.unimplemented("listPaymentMethods")
      }
    }

    await store.send(.onAppear) { $0.isLoading = true }
    await store.receive(\.paymentMethodsLoaded.failure) {
      $0.isLoading = false
      $0.error = String(describing: PaymentMethodAPIError.unimplemented("listPaymentMethods"))
    }
  }

  func test_refreshTapped_reloadsWithoutLoadingFlag() async {
    let a = makeMethod(isDefault: true)
    let store = TestStore(initialState: PaymentMethodsFeature.State(paymentMethods: [a])) {
      PaymentMethodsFeature()
    } withDependencies: {
      $0.paymentMethodAPIClient.listPaymentMethods = { [a] }
    }
    await store.send(.refreshTapped)
    await store.receive(\.paymentMethodsLoaded.success)
  }

  // MARK: - Aeropay link

  func test_linkBankTapped_opensSessionThenSafariSheet() async {
    let session = makeSession()
    let store = TestStore(initialState: PaymentMethodsFeature.State()) {
      PaymentMethodsFeature()
    } withDependencies: {
      $0.paymentMethodAPIClient.linkAeropay = { session }
    }

    await store.send(.linkBankTapped) { $0.isLinking = true }
    await store.receive(\.linkSessionResponse.success) {
      $0.isLinking = false
      $0.linkSession = session
    }
  }

  func test_linkBankTapped_whileLinking_isNoop() async {
    let store = TestStore(initialState: PaymentMethodsFeature.State(isLinking: true)) {
      PaymentMethodsFeature()
    }
    await store.send(.linkBankTapped)
  }

  func test_linkSessionResponse_failure_surfacesError() async {
    let store = TestStore(initialState: PaymentMethodsFeature.State()) {
      PaymentMethodsFeature()
    } withDependencies: {
      $0.paymentMethodAPIClient.linkAeropay = {
        throw PaymentMethodAPIError.unimplemented("linkAeropay")
      }
    }

    await store.send(.linkBankTapped) { $0.isLinking = true }
    await store.receive(\.linkSessionResponse.failure) {
      $0.isLinking = false
      $0.error = String(describing: PaymentMethodAPIError.unimplemented("linkAeropay"))
    }
  }

  func test_linkSheetDismissed_clearsSessionAndReloads() async {
    let session = makeSession()
    let linked = makeMethod(isDefault: false)
    let store = TestStore(
      initialState: PaymentMethodsFeature.State(linkSession: session)
    ) {
      PaymentMethodsFeature()
    } withDependencies: {
      $0.paymentMethodAPIClient.listPaymentMethods = { [linked] }
    }

    await store.send(.linkSheetDismissed) { $0.linkSession = nil }
    await store.receive(\.paymentMethodsLoaded.success) { $0.paymentMethods = [linked] }
  }

  func test_linkSheetDismissed_withoutSession_isNoop() async {
    let store = TestStore(initialState: PaymentMethodsFeature.State()) {
      PaymentMethodsFeature()
    }
    await store.send(.linkSheetDismissed)
  }

  // MARK: - Make default

  func test_makeDefaultTapped_promotesThenReloads() async {
    let a = makeMethod(isDefault: false)
    let b = makeMethod(isDefault: true)
    let promotedA = a.with(isDefault: true)
    let demotedB = b.with(isDefault: false)
    let probe = Locker<UUID?>(value: nil)

    let store = TestStore(
      initialState: PaymentMethodsFeature.State(paymentMethods: [a, b])
    ) {
      PaymentMethodsFeature()
    } withDependencies: {
      $0.paymentMethodAPIClient.setDefault = { id in
        await probe.set(id)
        return promotedA
      }
      $0.paymentMethodAPIClient.listPaymentMethods = { [promotedA, demotedB] }
    }

    await store.send(.makeDefaultTapped(a.id)) { $0.rowActionID = a.id }
    await store.receive(\.makeDefaultResponse.success) { $0.rowActionID = nil }
    await store.receive(\.paymentMethodsLoaded.success) { $0.paymentMethods = [promotedA, demotedB] }

    let observed = await probe.value
    XCTAssertEqual(observed, a.id)
  }

  func test_makeDefaultTapped_alreadyDefault_isNoop() async {
    let a = makeMethod(isDefault: true)
    let store = TestStore(initialState: PaymentMethodsFeature.State(paymentMethods: [a])) {
      PaymentMethodsFeature()
    }
    await store.send(.makeDefaultTapped(a.id))
  }

  func test_makeDefaultTapped_nonActiveMethod_isNoop() async {
    // A pending/failed method can't be promoted — the server returns 409,
    // so the reducer refuses to fire the doomed request.
    let pending = makeMethod(isDefault: false, status: .pending)
    let store = TestStore(initialState: PaymentMethodsFeature.State(paymentMethods: [pending])) {
      PaymentMethodsFeature()
    }
    await store.send(.makeDefaultTapped(pending.id))
  }

  func test_makeDefaultTapped_whileRowBusy_isNoop() async {
    let a = makeMethod(isDefault: false)
    let b = makeMethod(isDefault: true)
    let store = TestStore(
      initialState: PaymentMethodsFeature.State(paymentMethods: [a, b], rowActionID: b.id)
    ) {
      PaymentMethodsFeature()
    }
    await store.send(.makeDefaultTapped(a.id))
  }

  func test_makeDefaultResponse_failure_surfacesError() async {
    let a = makeMethod(isDefault: false)
    let store = TestStore(initialState: PaymentMethodsFeature.State(paymentMethods: [a])) {
      PaymentMethodsFeature()
    } withDependencies: {
      $0.paymentMethodAPIClient.setDefault = { _ in
        throw PaymentMethodAPIError.unimplemented("setDefault")
      }
    }

    await store.send(.makeDefaultTapped(a.id)) { $0.rowActionID = a.id }
    await store.receive(\.makeDefaultResponse.failure) {
      $0.rowActionID = nil
      $0.error = String(describing: PaymentMethodAPIError.unimplemented("setDefault"))
    }
  }

  // MARK: - Delete

  func test_deleteFlow_confirmRemovesRow() async {
    let a = makeMethod(isDefault: false)
    let b = makeMethod(isDefault: true)
    let probe = Locker<UUID?>(value: nil)
    let store = TestStore(initialState: PaymentMethodsFeature.State(paymentMethods: [a, b])) {
      PaymentMethodsFeature()
    } withDependencies: {
      $0.paymentMethodAPIClient.deletePaymentMethod = { id in await probe.set(id) }
    }

    await store.send(.deleteTapped(a.id)) { $0.pendingDeleteID = a.id }
    await store.send(.deleteConfirmed) {
      $0.pendingDeleteID = nil
      $0.rowActionID = a.id
    }
    await store.receive(\.deleteResponse.success) {
      $0.rowActionID = nil
      $0.paymentMethods = [b]
    }

    let observed = await probe.value
    XCTAssertEqual(observed, a.id)
  }

  func test_deleteCanceled_clearsPending() async {
    let a = makeMethod(isDefault: false)
    let store = TestStore(initialState: PaymentMethodsFeature.State(paymentMethods: [a])) {
      PaymentMethodsFeature()
    }
    await store.send(.deleteTapped(a.id)) { $0.pendingDeleteID = a.id }
    await store.send(.deleteCanceled) { $0.pendingDeleteID = nil }
  }

  func test_deleteTapped_unknownRow_isNoop() async {
    let a = makeMethod(isDefault: false)
    let store = TestStore(initialState: PaymentMethodsFeature.State(paymentMethods: [a])) {
      PaymentMethodsFeature()
    }
    await store.send(.deleteTapped(UUID()))
  }

  func test_deleteTapped_whileRowBusy_isNoop() async {
    let a = makeMethod(isDefault: false)
    let b = makeMethod(isDefault: true)
    let store = TestStore(
      initialState: PaymentMethodsFeature.State(paymentMethods: [a, b], rowActionID: b.id)
    ) {
      PaymentMethodsFeature()
    }
    await store.send(.deleteTapped(a.id))
  }

  func test_deleteConfirmed_failure_keepsRowAndSurfacesError() async {
    let a = makeMethod(isDefault: false)
    let store = TestStore(initialState: PaymentMethodsFeature.State(paymentMethods: [a])) {
      PaymentMethodsFeature()
    } withDependencies: {
      $0.paymentMethodAPIClient.deletePaymentMethod = { _ in
        throw PaymentMethodAPIError.unimplemented("deletePaymentMethod")
      }
    }

    await store.send(.deleteTapped(a.id)) { $0.pendingDeleteID = a.id }
    await store.send(.deleteConfirmed) {
      $0.pendingDeleteID = nil
      $0.rowActionID = a.id
    }
    await store.receive(\.deleteResponse.failure) {
      $0.rowActionID = nil
      $0.error = String(describing: PaymentMethodAPIError.unimplemented("deletePaymentMethod"))
    }
    XCTAssertEqual(store.state.paymentMethods, [a], "a failed delete leaves the row in place")
  }

  func test_deleteConfirmed_withoutPending_isNoop() async {
    let store = TestStore(initialState: PaymentMethodsFeature.State()) {
      PaymentMethodsFeature()
    }
    await store.send(.deleteConfirmed)
  }

  // MARK: - State helpers

  func test_pendingDeletePaymentMethod_resolvesFromID() {
    let a = makeMethod(isDefault: false)
    let state = PaymentMethodsFeature.State(paymentMethods: [a], pendingDeleteID: a.id)
    XCTAssertEqual(state.pendingDeletePaymentMethod, a)
  }
}

// MARK: - Fixtures

private func makeMethod(
  isDefault: Bool,
  status: PaymentMethodStatus = .active
) -> PaymentMethod {
  PaymentMethod(
    id: UUID(),
    type: .aeropayACH,
    aeropayPaymentMethodRef: "ba_test_123",
    bankName: "Test Bank",
    last4: "1234",
    isDefault: isDefault,
    status: status,
    createdAt: Date(timeIntervalSinceReferenceDate: 0),
    updatedAt: Date(timeIntervalSinceReferenceDate: 0)
  )
}

private func makeSession() -> AeropayLinkSession {
  AeropayLinkSession(
    id: "link_session_test_1",
    hostedUrl: URL(string: "https://link.aeropay.com/session/test_1")!,
    expiresAt: Date(timeIntervalSinceReferenceDate: 0)
  )
}

private extension PaymentMethod {
  func with(isDefault: Bool) -> PaymentMethod {
    PaymentMethod(
      id: id,
      type: type,
      aeropayPaymentMethodRef: aeropayPaymentMethodRef,
      bankName: bankName,
      last4: last4,
      isDefault: isDefault,
      status: status,
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
