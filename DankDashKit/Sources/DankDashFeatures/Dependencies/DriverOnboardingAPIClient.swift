import Foundation
import ComposableArchitecture
import DankDashDomain
import DankDashNetwork

/// `@DependencyClient`-style abstraction over `POST /v1/driver/applications`.
///
/// The endpoint isn't yet built (Phase 19 documented gap); when the
/// live binding receives a 404 it surfaces
/// `DriverOnboardingAPIError.endpointNotYetAvailable` so the reducer
/// can transition to the pending screen with a "queued — admin will
/// reach out" message. Once the endpoint lands, the existing call
/// path just returns a real response unchanged.
public struct DriverOnboardingAPIClient: Sendable {
  public var submitApplication: @Sendable (DriverApplicationDraft) async throws -> DriverApplicationSubmission

  public init(
    submitApplication: @Sendable @escaping (DriverApplicationDraft) async throws -> DriverApplicationSubmission
  ) {
    self.submitApplication = submitApplication
  }
}

/// Outcome of a successful submission. Holds the server-side
/// application id + status + (optional) queue position so the pending
/// screen can render "You're #3 in the queue" when the backend
/// supports it.
public struct DriverApplicationSubmission: Sendable, Equatable {
  public let applicationId: UUID
  public let status: String
  public let queuePosition: Int?

  public init(applicationId: UUID, status: String, queuePosition: Int?) {
    self.applicationId = applicationId
    self.status = status
    self.queuePosition = queuePosition
  }
}

public extension DriverOnboardingAPIClient {
  static func live(apiClient: APIClient) -> DriverOnboardingAPIClient {
    DriverOnboardingAPIClient { draft in
      guard let body = DriverApplicationRequestDTO.from(draft) else {
        throw DriverOnboardingAPIError.draftIncomplete
      }
      do {
        let response = try await apiClient.send(
          DriverOnboardingEndpoints.submitApplication(body: body)
        )
        guard let parsedID = UUID(uuidString: response.applicationId) else {
          throw DriverAPIError.malformedPayload("DriverApplicationResponse")
        }
        return DriverApplicationSubmission(
          applicationId: parsedID,
          status: response.status,
          queuePosition: response.queuePosition
        )
      } catch let error as APIError {
        if case .server(let status, _) = error, status == 404 {
          throw DriverOnboardingAPIError.endpointNotYetAvailable
        }
        if case .unexpectedStatus(let status, _) = error, status == 404 {
          throw DriverOnboardingAPIError.endpointNotYetAvailable
        }
        throw error
      }
    }
  }

  static let unimplemented = DriverOnboardingAPIClient(
    submitApplication: { _ in throw DriverAPIError.unimplemented("submitApplication") }
  )
}

/// Errors specific to driver onboarding. The reducer pattern-matches on
/// `.endpointNotYetAvailable` to land on the pending screen with the
/// "queued" flag set; `.draftIncomplete` should be unreachable from the
/// review screen (the submit button is disabled by `isReadyToSubmit`).
public enum DriverOnboardingAPIError: Error, Sendable, Equatable {
  case endpointNotYetAvailable
  case draftIncomplete
}

private enum DriverOnboardingAPIClientKey: DependencyKey {
  static let liveValue: DriverOnboardingAPIClient = .unimplemented
  static let testValue: DriverOnboardingAPIClient = .unimplemented
}

public extension DependencyValues {
  var driverOnboardingAPIClient: DriverOnboardingAPIClient {
    get { self[DriverOnboardingAPIClientKey.self] }
    set { self[DriverOnboardingAPIClientKey.self] = newValue }
  }
}
