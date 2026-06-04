import Foundation

/// Codable, type-erased JSON value. Used for server-side payloads whose
/// shape varies per row / per event and would be brittle to lock into a
/// concrete Swift type:
///
/// - `OrderItem.productSnapshot` — the catalog row as it stood at
///   checkout time. Adding a "lab results" pill on the server extends
///   the snapshot, not this wire shape.
/// - `RuleResult.details` — per-rule details. The geofence rule carries
///   `{ latitude, longitude, polygon }`, the per-transaction-limit
///   rule carries `{ flowerGramsOver: ... }`, etc.
/// - `OrderEvent.payload` — varies per `eventType`.
///
/// The case set matches the seven JSON value kinds. Integers are kept
/// distinct from floating-point numbers so a JSON `42` round-trips as
/// `.int(42)` rather than `.double(42.0)` — handy when downstream code
/// pattern-matches a specific integer field on the snapshot. Recursive
/// (`array`, `object`) cases are reached via `indirect` so the enum has
/// a finite size.
public indirect enum AnyValue: Hashable, Sendable {
  case null
  case bool(Bool)
  case int(Int)
  case double(Double)
  case string(String)
  case array([AnyValue])
  case object([String: AnyValue])
}

extension AnyValue: Codable {
  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    // Order matters. `decodeNil()` is non-destructive and must run first.
    // Bool before Int because a JSON `true` should not silently become an
    // integer. Int before Double so a JSON integer (`42`) keeps its `.int`
    // discriminator instead of being smeared into `.double(42.0)`. String,
    // then array, then object as the remaining types.
    if container.decodeNil() {
      self = .null
    } else if let bool = try? container.decode(Bool.self) {
      self = .bool(bool)
    } else if let int = try? container.decode(Int.self) {
      self = .int(int)
    } else if let double = try? container.decode(Double.self) {
      self = .double(double)
    } else if let string = try? container.decode(String.self) {
      self = .string(string)
    } else if let array = try? container.decode([AnyValue].self) {
      self = .array(array)
    } else if let object = try? container.decode([String: AnyValue].self) {
      self = .object(object)
    } else {
      throw DecodingError.dataCorruptedError(
        in: container,
        debugDescription: "Unsupported JSON value"
      )
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .null: try container.encodeNil()
    case .bool(let value): try container.encode(value)
    case .int(let value): try container.encode(value)
    case .double(let value): try container.encode(value)
    case .string(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .object(let value): try container.encode(value)
    }
  }
}

extension AnyValue {
  /// Convenience accessor for `.object(...)` payloads. Returns `nil` for
  /// every other case so a caller can `payload.object?["orderId"]`
  /// without unwrapping the enum manually.
  public var object: [String: AnyValue]? {
    if case .object(let dict) = self { return dict }
    return nil
  }

  /// Convenience accessor for `.string(...)` values. Returns `nil` for
  /// any non-string variant (including `.null`).
  public var string: String? {
    if case .string(let value) = self { return value }
    return nil
  }
}
