import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Sheet-mounted reducer the cart pushes when the user taps the address
/// row. Loads the user's saved addresses, lets them pick one, and
/// inline-adds a new address via CLGeocoder + `POST /v1/addresses`.
///
/// The reducer owns the "Add new address" sub-form so the parent never
/// holds half-typed form state. On a successful pick (or on a successful
/// add-then-pick), it emits ``Action/Delegate/addressSelected`` so the
/// cart can re-run validate with the new address id. Dismissal without
/// a pick emits ``Action/Delegate/dismissed`` so the parent can close
/// the sheet.
@Reducer
public struct AddressPickerFeature: Sendable {
  @ObservableState
  public struct State: Equatable, Sendable {
    /// Server-loaded addresses, default first. Populated by ``onAppear``.
    public var addresses: [UserAddress]

    /// Highlighted row — the value the parent should observe when the
    /// user dismisses (the "preview" state in case the user changes
    /// their mind before confirming).
    public var selectedAddressId: UUID?

    public var isLoading: Bool

    /// Recoverable error text — surfaced as an inline banner at the top
    /// of the picker. `nil` when the picker is in a healthy state.
    public var error: String?

    /// Inline-form state. `nil` when the picker is in pick-only mode;
    /// non-`nil` when the user tapped "+ Add new address".
    public var draft: NewAddressDraft?

    /// Geocode and create steps run sequentially and share a single
    /// "busy" spinner. Both fall back to false on error so the user can
    /// retry without re-opening the picker.
    public var isGeocoding: Bool
    public var isCreating: Bool

    public init(
      addresses: [UserAddress] = [],
      selectedAddressId: UUID? = nil,
      isLoading: Bool = false,
      error: String? = nil,
      draft: NewAddressDraft? = nil,
      isGeocoding: Bool = false,
      isCreating: Bool = false
    ) {
      self.addresses = addresses
      self.selectedAddressId = selectedAddressId
      self.isLoading = isLoading
      self.error = error
      self.draft = draft
      self.isGeocoding = isGeocoding
      self.isCreating = isCreating
    }

    /// "Save" enablement on the form. Geocode + creating phases gate it
    /// off so the user can't double-submit while a request is in flight.
    public var canSubmitDraft: Bool {
      guard let draft else { return false }
      return draft.isComplete && !isGeocoding && !isCreating
    }
  }

  /// In-memory draft of the "Add new address" form. Pre-defaulted to
  /// "MN" since the consumer app only operates in Minnesota at Phase
  /// 18; users can still edit the field if they're typing in a future
  /// out-of-state delivery (which the server will reject as out of
  /// service area — that's fine).
  public struct NewAddressDraft: Equatable, Sendable {
    public var label: String
    public var line1: String
    public var line2: String
    public var city: String
    public var region: String
    public var postalCode: String
    public var deliveryInstructions: String
    public var setAsDefault: Bool

    public init(
      label: String = "",
      line1: String = "",
      line2: String = "",
      city: String = "",
      region: String = "MN",
      postalCode: String = "",
      deliveryInstructions: String = "",
      setAsDefault: Bool = false
    ) {
      self.label = label
      self.line1 = line1
      self.line2 = line2
      self.city = city
      self.region = region
      self.postalCode = postalCode
      self.deliveryInstructions = deliveryInstructions
      self.setAsDefault = setAsDefault
    }

    /// Minimum bar for kicking off the geocode + create round trip.
    /// "Label" + "line2" + "delivery instructions" are optional; line1,
    /// city, region, postal code are required (the server rejects a
    /// half-formed body anyway).
    public var isComplete: Bool {
      !line1.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && !city.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && !region.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && !postalCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    fileprivate var geocodeQuery: GeocodingClient.GeocodeQuery {
      GeocodingClient.GeocodeQuery(
        line1: line1,
        line2: line2.isEmpty ? nil : line2,
        city: city,
        region: region,
        postalCode: postalCode
      )
    }

    fileprivate func createRequest(coordinate: Coordinate) -> CreateAddressRequestDTO {
      CreateAddressRequestDTO(
        label: label.isEmpty ? nil : label,
        line1: line1,
        line2: line2.isEmpty ? nil : line2,
        city: city,
        region: region,
        postalCode: postalCode,
        latitude: coordinate.latitude,
        longitude: coordinate.longitude,
        deliveryInstructions: deliveryInstructions.isEmpty ? nil : deliveryInstructions,
        setAsDefault: setAsDefault
      )
    }
  }

  public enum Action: Sendable {
    case onAppear
    case addressesLoaded(Result<[UserAddress], EquatableError>)

    case selectAddress(UUID)
    case confirmSelection
    case dismissTapped

    case startAddingNew
    case cancelAddingNew
    case updateLabel(String)
    case updateLine1(String)
    case updateLine2(String)
    case updateCity(String)
    case updateRegion(String)
    case updatePostalCode(String)
    case updateDeliveryInstructions(String)
    case toggleSetAsDefault(Bool)

    case saveDraftTapped
    case geocodeCompleted(Result<Coordinate, EquatableError>)
    case addressCreated(Result<UserAddress, EquatableError>)

    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Sendable, Equatable {
      case addressSelected(UserAddress)
      case dismissed
    }
  }

  @Dependency(\.addressAPIClient) var addressAPIClient
  @Dependency(\.geocodingClient) var geocodingClient

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .onAppear:
        guard !state.isLoading, state.addresses.isEmpty else { return .none }
        state.isLoading = true
        return .run { [addressAPIClient] send in
          do {
            let addresses = try await addressAPIClient.listAddresses()
            await send(.addressesLoaded(.success(addresses)))
          } catch {
            await send(.addressesLoaded(.failure(EquatableError(error))))
          }
        }

      case .addressesLoaded(.success(let addresses)):
        state.isLoading = false
        state.addresses = addresses
        if state.selectedAddressId == nil {
          state.selectedAddressId = addresses.first(where: \.isDefault)?.id ?? addresses.first?.id
        }
        return .none

      case .addressesLoaded(.failure(let error)):
        state.isLoading = false
        state.error = error.message
        return .none

      // MARK: Selection

      case .selectAddress(let id):
        guard state.addresses.contains(where: { $0.id == id }) else { return .none }
        state.selectedAddressId = id
        return .none

      case .confirmSelection:
        guard let id = state.selectedAddressId,
              let address = state.addresses.first(where: { $0.id == id }) else {
          return .none
        }
        return .send(.delegate(.addressSelected(address)))

      case .dismissTapped:
        return .send(.delegate(.dismissed))

      // MARK: Add form

      case .startAddingNew:
        state.draft = NewAddressDraft()
        state.error = nil
        return .none

      case .cancelAddingNew:
        state.draft = nil
        state.error = nil
        return .none

      case .updateLabel(let value):
        state.draft?.label = value
        return .none

      case .updateLine1(let value):
        state.draft?.line1 = value
        return .none

      case .updateLine2(let value):
        state.draft?.line2 = value
        return .none

      case .updateCity(let value):
        state.draft?.city = value
        return .none

      case .updateRegion(let value):
        state.draft?.region = value
        return .none

      case .updatePostalCode(let value):
        state.draft?.postalCode = value
        return .none

      case .updateDeliveryInstructions(let value):
        state.draft?.deliveryInstructions = value
        return .none

      case .toggleSetAsDefault(let value):
        state.draft?.setAsDefault = value
        return .none

      // MARK: Save (geocode → create)

      case .saveDraftTapped:
        guard let draft = state.draft, draft.isComplete,
              !state.isGeocoding, !state.isCreating else { return .none }
        state.isGeocoding = true
        state.error = nil
        return .run { [geocodingClient] send in
          do {
            let coord = try await geocodingClient.geocode(draft.geocodeQuery)
            await send(.geocodeCompleted(.success(coord)))
          } catch {
            await send(.geocodeCompleted(.failure(EquatableError(error))))
          }
        }

      case .geocodeCompleted(.success(let coord)):
        state.isGeocoding = false
        guard let draft = state.draft else { return .none }
        state.isCreating = true
        let body = draft.createRequest(coordinate: coord)
        return .run { [addressAPIClient] send in
          do {
            let address = try await addressAPIClient.createAddress(body)
            await send(.addressCreated(.success(address)))
          } catch {
            await send(.addressCreated(.failure(EquatableError(error))))
          }
        }

      case .geocodeCompleted(.failure(let error)):
        state.isGeocoding = false
        state.error = error.message
        return .none

      case .addressCreated(.success(let address)):
        state.isCreating = false
        // If the new row is the singleton default, demote every other.
        if address.isDefault {
          state.addresses = state.addresses.map {
            $0.isDefault ? demoted($0) : $0
          }
        }
        state.addresses.insert(address, at: 0)
        state.selectedAddressId = address.id
        state.draft = nil
        return .send(.delegate(.addressSelected(address)))

      case .addressCreated(.failure(let error)):
        state.isCreating = false
        state.error = error.message
        return .none

      // MARK: Delegate

      case .delegate:
        return .none
      }
    }
  }
}

// MARK: - Helpers

/// Local mirror of a `UserAddress` with `isDefault = false`. Used when
/// the server promotes a newly-created address to singleton default and
/// we need to demote the previous row in the local list (rather than
/// waiting for a refetch).
private func demoted(_ address: UserAddress) -> UserAddress {
  UserAddress(
    id: address.id,
    label: address.label,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    region: address.region,
    postalCode: address.postalCode,
    country: address.country,
    location: address.location,
    isDefault: false,
    isValidated: address.isValidated,
    validatedAt: address.validatedAt,
    deliveryInstructions: address.deliveryInstructions,
    createdAt: address.createdAt,
    updatedAt: address.updatedAt
  )
}
