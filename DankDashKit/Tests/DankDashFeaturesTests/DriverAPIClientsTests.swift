import XCTest
import Foundation
import DankDashDomain
import DankDashNetwork
@testable import DankDashFeatures

/// Tests the typed surface + the `unimplemented` fixtures of every
/// driver-side API client. The live bindings are exercised in
/// integration smoke runs against the dev backend; here we cover the
/// pure-Swift contract reducers will depend on.
final class DriverAPIClientsTests: XCTestCase {
  // MARK: - DriverShiftAPIClient

  func test_shiftClient_unimplementedThrowsForEachMethod() async {
    let client = DriverShiftAPIClient.unimplemented
    await expectUnimplemented(match: "startShift") {
      _ = try await client.startShift(.minneapolis)
    }
    await expectUnimplemented(match: "endShift") {
      _ = try await client.endShift(.minneapolis)
    }
    await expectUnimplemented(match: "updateStatus") {
      _ = try await client.updateStatus(.online)
    }
  }

  func test_shiftClient_customStartShiftPassesCoordinateThrough() async throws {
    let probe = Locker<Coordinate?>(value: nil)
    let stub = stubShift()
    let client = DriverShiftAPIClient(
      startShift: { coord in
        await probe.set(coord)
        return stub
      },
      endShift: { _ in stub },
      updateStatus: { _ in stubDriver() }
    )
    _ = try await client.startShift(.minneapolis)
    let captured = await probe.value
    XCTAssertEqual(captured, .minneapolis)
  }

  // MARK: - DriverAppAPIClient

  func test_appClient_unimplementedThrowsForEachMethod() async {
    let client = DriverAppAPIClient.unimplemented
    await expectUnimplemented(match: "getMe") {
      _ = try await client.getMe()
    }
    await expectUnimplemented(match: "getCurrentRoute") {
      _ = try await client.getCurrentRoute()
    }
    await expectUnimplemented(match: "getEarnings") {
      _ = try await client.getEarnings(.today)
    }
    await expectUnimplemented(match: "getShifts") {
      _ = try await client.getShifts()
    }
  }

  func test_appClient_endpointNotYetAvailableErrorIsEquatable() {
    XCTAssertEqual(
      DriverAppAPIError.endpointNotYetAvailable,
      DriverAppAPIError.endpointNotYetAvailable
    )
  }

  // MARK: - DriverHeatmapAPIClient

  func test_heatmapClient_unimplementedThrows() async {
    let client = DriverHeatmapAPIClient.unimplemented
    do {
      _ = try await client.getHeatmap(near: .minneapolis)
      XCTFail("expected throw")
    } catch let error as DriverAPIError {
      if case .unimplemented(let name) = error {
        XCTAssertEqual(name, "getHeatmap")
      } else {
        XCTFail("expected .unimplemented, got \(error)")
      }
    } catch {
      XCTFail("unexpected error: \(error)")
    }
  }

  func test_heatmapClient_defaultRadiusIs8000() async throws {
    let probe = Locker<(Coordinate, Int)?>(value: nil)
    let client = DriverHeatmapAPIClient { coord, radius in
      await probe.set((coord, radius))
      return []
    }
    _ = try await client.getHeatmap(near: .minneapolis)
    let captured = await probe.value
    let unwrapped = try XCTUnwrap(captured)
    XCTAssertEqual(unwrapped.0, .minneapolis)
    XCTAssertEqual(unwrapped.1, 8_000)
  }

  func test_heatmapClient_customRadiusPassedThrough() async throws {
    let probe = Locker<Int?>(value: nil)
    let client = DriverHeatmapAPIClient { _, radius in
      await probe.set(radius)
      return []
    }
    _ = try await client.getHeatmap(.minneapolis, 4_000)
    let captured = await probe.value
    XCTAssertEqual(captured, 4_000)
  }

  // MARK: - DriverOnboardingAPIClient

  func test_onboardingClient_unimplementedThrows() async {
    let client = DriverOnboardingAPIClient.unimplemented
    do {
      _ = try await client.submitApplication(DriverApplicationDraft())
      XCTFail("expected throw")
    } catch let error as DriverAPIError {
      if case .unimplemented(let name) = error {
        XCTAssertEqual(name, "submitApplication")
      } else {
        XCTFail("expected .unimplemented, got \(error)")
      }
    } catch {
      XCTFail("unexpected error: \(error)")
    }
  }

  func test_onboardingError_endpointNotYetAvailableIsEquatable() {
    XCTAssertEqual(
      DriverOnboardingAPIError.endpointNotYetAvailable,
      DriverOnboardingAPIError.endpointNotYetAvailable
    )
    XCTAssertNotEqual(
      DriverOnboardingAPIError.endpointNotYetAvailable,
      DriverOnboardingAPIError.draftIncomplete
    )
  }

  func test_onboardingSubmission_isEquatableValueType() {
    let id = UUID()
    let a = DriverApplicationSubmission(applicationId: id, status: "pending", queuePosition: 3)
    let b = DriverApplicationSubmission(applicationId: id, status: "pending", queuePosition: 3)
    XCTAssertEqual(a, b)
  }

  // MARK: - DocumentPickerClient

  func test_pickerClient_unimplementedThrowsUnavailable() async {
    let client = DocumentPickerClient.unimplemented
    do {
      _ = try await client.pick(.files)
      XCTFail("expected throw")
    } catch let error as DocumentPickerClientError {
      XCTAssertEqual(error, .unavailable)
    } catch {
      XCTFail("unexpected error: \(error)")
    }
  }

  func test_pickerClient_testFixtureReturnsSuppliedDocument() async throws {
    let picked = PickedDocument(
      url: URL(fileURLWithPath: "/tmp/sample.pdf"),
      mimeType: "application/pdf",
      sizeBytes: 2_048,
      capturedAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
    let client = DocumentPickerClient.test(picked)
    let result = try await client.pick(.files)
    XCTAssertEqual(result, picked)
  }

  func test_pickerClient_failingFixtureThrowsSuppliedError() async {
    let client = DocumentPickerClient.failing(.cancelled)
    do {
      _ = try await client.pick(.photoLibrary)
      XCTFail("expected throw")
    } catch let error as DocumentPickerClientError {
      XCTAssertEqual(error, .cancelled)
    } catch {
      XCTFail("unexpected error: \(error)")
    }
  }

  // MARK: - Helpers

  private func expectUnimplemented(
    match expected: String,
    file: StaticString = #filePath,
    line: UInt = #line,
    _ body: () async throws -> Void
  ) async {
    do {
      try await body()
      XCTFail("expected to throw .unimplemented(\(expected))", file: file, line: line)
    } catch let error as DriverAPIError {
      if case .unimplemented(let name) = error {
        XCTAssertTrue(
          name.contains(expected),
          "unimplemented(\(name)) did not contain \(expected)",
          file: file, line: line
        )
      } else {
        XCTFail("expected .unimplemented, got \(error)", file: file, line: line)
      }
    } catch {
      XCTFail("unexpected error: \(error)", file: file, line: line)
    }
  }
}

// MARK: - Fixtures

private func stubShift() -> DriverShift {
  DriverShift(
    id: UUID(),
    driverId: UUID(),
    startedAt: Date(timeIntervalSince1970: 1_700_000_000),
    endedAt: nil,
    startingLocation: .minneapolis,
    endingLocation: nil,
    totalMiles: nil,
    totalDeliveries: 0,
    totalEarningsCents: 0
  )
}

private func stubDriver() -> Driver {
  Driver(
    id: UUID(),
    userId: UUID(),
    vehicle: Vehicle(),
    insuranceDocKey: nil,
    insuranceExpiresAt: nil,
    backgroundCheckPassedAt: nil,
    backgroundCheckProviderRef: nil,
    currentStatus: .offline,
    lastStatusChangeAt: Date(timeIntervalSince1970: 1_700_000_000),
    currentLocation: nil,
    currentLocationUpdatedAt: nil,
    currentOrderId: nil,
    ratingAvg: nil,
    ratingCount: 0,
    totalDeliveries: 0,
    createdAt: Date(timeIntervalSince1970: 1_700_000_000),
    updatedAt: Date(timeIntervalSince1970: 1_700_000_000)
  )
}

private extension Coordinate {
  static let minneapolis = Coordinate(latitude: 44.9778, longitude: -93.2650)
}

private actor Locker<T: Sendable> {
  private(set) var value: T
  init(value: T) { self.value = value }
  func set(_ newValue: T) { self.value = newValue }
}
