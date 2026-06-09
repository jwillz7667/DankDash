import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// Add-or-edit address form. One reducer drives both flows; ``Mode``
/// selects which. On save it geocodes the typed address (or reuses the
/// existing coordinate when editing and the address lines didn't change),
/// POSTs `/v1/addresses` (add) or PATCHes `/v1/addresses/:id` (edit), and
/// emits ``Action/Delegate/saved`` carrying the persisted row so the
/// parent list can refresh. Dismissal without saving emits
/// ``Action/Delegate/cancelled``.
///
/// Geocoding lives on-device (MapKit `CLGeocoder` via ``GeocodingClient``)
/// exactly as the cart's ``AddressPickerFeature`` does — the server trusts
/// the coordinate it's handed (see `addresses.service.ts`).
@Reducer
public struct AddressFormFeature: Sendable {
  public enum Mode: Equatable, Sendable {
    case add
    /// Edit an existing address. Carries the original so the reducer can
    /// (a) reuse its validated coordinate when the address lines are
    /// unchanged — skipping a needless geocode — and (b) know whether it
    /// already holds the singleton default (which gates the toggle).
    case edit(UserAddress)
  }

  @ObservableState
  public struct State: Equatable, Sendable {
    public var mode: Mode
    public var label: String
    public var line1: String
    public var line2: String
    public var city: String
    public var region: String
    public var postalCode: String
    public var deliveryInstructions: String
    public var setAsDefault: Bool
    public var isGeocoding: Bool
    public var isSaving: Bool
    public var error: String?

    public init(mode: Mode) {
      self.mode = mode
      switch mode {
      case .add:
        self.label = ""
        self.line1 = ""
        self.line2 = ""
        self.city = ""
        // Pre-default to MN — the consumer app only operates in Minnesota.
        self.region = "MN"
        self.postalCode = ""
        self.deliveryInstructions = ""
        self.setAsDefault = false
      case .edit(let address):
        self.label = address.label ?? ""
        self.line1 = address.line1
        self.line2 = address.line2 ?? ""
        self.city = address.city
        self.region = address.region
        self.postalCode = address.postalCode
        self.deliveryInstructions = address.deliveryInstructions ?? ""
        self.setAsDefault = address.isDefault
      }
      self.isGeocoding = false
      self.isSaving = false
      self.error = nil
    }

    public var isEditing: Bool {
      if case .edit = mode { return true }
      return false
    }

    /// True when editing the address that already holds the default. The
    /// toggle is locked on in that case — the only way to drop the default
    /// is to promote a *different* row, so it can't be turned off here.
    public var isEditingDefault: Bool {
      if case .edit(let address) = mode { return address.isDefault }
      return false
    }

    /// Whether a save should promote this row. Only when the user turned
    /// the toggle on for a row that isn't already the default — re-sending
    /// `isDefault: true` for the current default is a redundant write, and
    /// the server rejects `isDefault: false` outright.
    public var shouldPromote: Bool {
      setAsDefault && !isEditingDefault
    }

    /// Required-field bar before a geocode + persist round trip. Matches
    /// the server schema (line1/city/region/postalCode required; label,
    /// line2, delivery instructions optional).
    public var isComplete: Bool {
      !line1.isBlank && !city.isBlank && !region.isBlank && !postalCode.isBlank
    }

    public var canSave: Bool {
      isComplete && !isGeocoding && !isSaving
    }

    fileprivate var country: String {
      if case .edit(let address) = mode { return address.country }
      return "US"
    }

    fileprivate var geocodeQuery: GeocodingClient.GeocodeQuery {
      GeocodingClient.GeocodeQuery(
        line1: line1,
        line2: line2.isBlank ? nil : line2,
        city: city,
        region: region,
        postalCode: postalCode,
        country: country
      )
    }

    /// In edit mode, if none of the geocode-relevant lines changed we can
    /// reuse the previously-validated coordinate and skip the geocode.
    /// Returns nil when a geocode is required (add mode, or any line edited).
    fileprivate var reusableCoordinate: Coordinate? {
      guard case .edit(let original) = mode else { return nil }
      let unchanged =
        line1.normalized == original.line1.normalized
        && line2.normalized == (original.line2 ?? "").normalized
        && city.normalized == original.city.normalized
        && region.normalized == original.region.normalized
        && postalCode.normalized == original.postalCode.normalized
      return unchanged ? original.location : nil
    }

    fileprivate func createBody(coordinate: Coordinate) -> CreateAddressRequestDTO {
      CreateAddressRequestDTO(
        label: label.blankToNil,
        line1: line1,
        line2: line2.blankToNil,
        city: city,
        region: region,
        postalCode: postalCode,
        latitude: coordinate.latitude,
        longitude: coordinate.longitude,
        deliveryInstructions: deliveryInstructions.blankToNil,
        setAsDefault: setAsDefault
      )
    }

    fileprivate func editBody(coordinate: Coordinate) -> EditAddressRequestDTO {
      EditAddressRequestDTO(
        label: label.blankToNil,
        line1: line1,
        line2: line2.blankToNil,
        city: city,
        region: region,
        postalCode: postalCode,
        country: country,
        latitude: coordinate.latitude,
        longitude: coordinate.longitude,
        deliveryInstructions: deliveryInstructions.blankToNil,
        isDefault: shouldPromote ? true : nil
      )
    }
  }

  public enum Action: Sendable, Equatable {
    case updateLabel(String)
    case updateLine1(String)
    case updateLine2(String)
    case updateCity(String)
    case updateRegion(String)
    case updatePostalCode(String)
    case updateDeliveryInstructions(String)
    case toggleSetAsDefault(Bool)

    case saveTapped
    case cancelTapped
    case geocodeCompleted(Result<Coordinate, EquatableError>)
    case saved(Result<UserAddress, EquatableError>)

    case delegate(Delegate)

    @CasePathable
    public enum Delegate: Sendable, Equatable {
      case saved(UserAddress)
      case cancelled
    }
  }

  @Dependency(\.addressAPIClient) var addressAPIClient
  @Dependency(\.geocodingClient) var geocodingClient

  public init() {}

  public var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .updateLabel(let value):
        state.label = value
        return .none

      case .updateLine1(let value):
        state.line1 = value
        return .none

      case .updateLine2(let value):
        state.line2 = value
        return .none

      case .updateCity(let value):
        state.city = value
        return .none

      case .updateRegion(let value):
        state.region = value
        return .none

      case .updatePostalCode(let value):
        state.postalCode = value
        return .none

      case .updateDeliveryInstructions(let value):
        state.deliveryInstructions = value
        return .none

      case .toggleSetAsDefault(let value):
        // Editing the current default can't drop the flag from here.
        guard !state.isEditingDefault else { return .none }
        state.setAsDefault = value
        return .none

      case .saveTapped:
        guard state.canSave else { return .none }
        state.error = nil
        if let coordinate = state.reusableCoordinate {
          state.isSaving = true
          return persist(state: state, coordinate: coordinate)
        }
        state.isGeocoding = true
        return .run { [geocodingClient, query = state.geocodeQuery] send in
          do {
            let coordinate = try await geocodingClient.geocode(query)
            await send(.geocodeCompleted(.success(coordinate)))
          } catch {
            await send(.geocodeCompleted(.failure(EquatableError(error))))
          }
        }

      case .geocodeCompleted(.success(let coordinate)):
        state.isGeocoding = false
        state.isSaving = true
        return persist(state: state, coordinate: coordinate)

      case .geocodeCompleted(.failure(let error)):
        state.isGeocoding = false
        state.error = error.message
        return .none

      case .saved(.success(let address)):
        state.isSaving = false
        return .send(.delegate(.saved(address)))

      case .saved(.failure(let error)):
        state.isSaving = false
        state.error = error.message
        return .none

      case .cancelTapped:
        return .send(.delegate(.cancelled))

      case .delegate:
        return .none
      }
    }
  }

  /// Issues the create (add) or edit (PATCH) request and folds the result
  /// into a ``Action/saved`` outcome. Pure routing — the busy flag is
  /// already set by the caller.
  private func persist(state: State, coordinate: Coordinate) -> Effect<Action> {
    switch state.mode {
    case .add:
      let body = state.createBody(coordinate: coordinate)
      return .run { [addressAPIClient = self.addressAPIClient] send in
        do {
          let address = try await addressAPIClient.createAddress(body)
          await send(.saved(.success(address)))
        } catch {
          await send(.saved(.failure(EquatableError(error))))
        }
      }
    case .edit(let original):
      let body = state.editBody(coordinate: coordinate)
      return .run { [addressAPIClient = self.addressAPIClient] send in
        do {
          let address = try await addressAPIClient.editAddress(original.id, body)
          await send(.saved(.success(address)))
        } catch {
          await send(.saved(.failure(EquatableError(error))))
        }
      }
    }
  }
}

// MARK: - String helpers

private extension String {
  var isBlank: Bool {
    trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  /// `nil` for a whitespace-only value so optional fields ship as JSON
  /// `null` (clear) rather than an empty string the server would reject.
  var blankToNil: String? {
    isBlank ? nil : self
  }

  var normalized: String {
    trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
