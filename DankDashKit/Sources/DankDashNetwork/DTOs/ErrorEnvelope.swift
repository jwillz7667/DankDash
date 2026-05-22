import Foundation

/// Mirror of the backend `ErrorEnvelope` (packages/types/src/errors.ts).
/// The server always returns this shape for non-2xx responses:
///
///   { "error": { "code": "...", "message": "...", "details": {}, "request_id": "..." } }
///
/// `details` is an open record by contract; the iOS client keeps it as a
/// JSON dictionary and pulls structured fields out on demand.
public struct ErrorEnvelope: Decodable, Sendable, Equatable {
  public let error: ErrorBody

  public struct ErrorBody: Decodable, Sendable, Equatable {
    public let code: String
    public let message: String
    public let details: JSONValue
    public let requestId: String?

    enum CodingKeys: String, CodingKey {
      case code
      case message
      case details
      case requestId = "request_id"
    }

    public init(
      code: String,
      message: String,
      details: JSONValue = .object([:]),
      requestId: String? = nil
    ) {
      self.code = code
      self.message = message
      self.details = details
      self.requestId = requestId
    }

    public init(from decoder: Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      self.code = try container.decode(String.self, forKey: .code)
      self.message = try container.decode(String.self, forKey: .message)
      self.details = try container.decodeIfPresent(JSONValue.self, forKey: .details) ?? .object([:])
      self.requestId = try container.decodeIfPresent(String.self, forKey: .requestId)
    }
  }

  public init(error: ErrorBody) {
    self.error = error
  }
}

/// A minimal recursive JSON value so we can decode the open `details`
/// payload without throwing it on the floor.
public indirect enum JSONValue: Decodable, Sendable, Equatable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let bool = try? container.decode(Bool.self) {
      self = .bool(bool)
    } else if let int = try? container.decode(Int.self) {
      self = .number(Double(int))
    } else if let double = try? container.decode(Double.self) {
      self = .number(double)
    } else if let string = try? container.decode(String.self) {
      self = .string(string)
    } else if let array = try? container.decode([JSONValue].self) {
      self = .array(array)
    } else if let object = try? container.decode([String: JSONValue].self) {
      self = .object(object)
    } else {
      throw DecodingError.dataCorruptedError(
        in: container,
        debugDescription: "unsupported JSON value"
      )
    }
  }

  public var stringValue: String? {
    if case .string(let value) = self { return value }
    return nil
  }
}
