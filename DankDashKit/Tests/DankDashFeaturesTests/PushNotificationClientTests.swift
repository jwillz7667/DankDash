import XCTest
import Foundation
@testable import DankDashFeatures

final class PushNotificationClientTests: XCTestCase {
  // MARK: - Token enum

  func test_token_isEquatablePerCase() {
    let data1 = Data([0x01, 0x02, 0x03])
    let data2 = Data([0x01, 0x02, 0x03])
    let data3 = Data([0xff])

    XCTAssertEqual(PushNotificationToken.registered(data1), .registered(data2))
    XCTAssertNotEqual(PushNotificationToken.registered(data1), .registered(data3))
    XCTAssertNotEqual(PushNotificationToken.registered(data1), .failed("denied"))
    XCTAssertEqual(PushNotificationToken.failed("denied"), .failed("denied"))
    XCTAssertNotEqual(PushNotificationToken.failed("denied"), .failed("other"))
  }

  // MARK: - .unimplemented surface

  func test_unimplemented_authorizationReturnsFalse() async {
    let client = PushNotificationClient.unimplemented
    let granted = await client.requestAuthorization()
    XCTAssertFalse(granted)
  }

  func test_unimplemented_registerForRemoteNotificationsIsNoOp() async {
    let client = PushNotificationClient.unimplemented
    await client.registerForRemoteNotifications()
  }

  func test_unimplemented_submitTokenIsNoOp() async {
    let client = PushNotificationClient.unimplemented
    client.submitDeviceToken(Data([0x01]))
    client.submitRegistrationFailure(NSError(domain: "test", code: 1))
  }

  // MARK: - Custom client surface

  func test_customClient_tokenUpdatesYieldFromSubmit() async {
    let (stream, continuation) = AsyncStream<PushNotificationToken>.makeStream()
    let client = PushNotificationClient(
      requestAuthorization: { true },
      registerForRemoteNotifications: { },
      submitDeviceToken: { token in continuation.yield(.registered(token)) },
      submitRegistrationFailure: { error in continuation.yield(.failed(error.localizedDescription)) },
      tokenUpdates: { stream }
    )

    let collected: AsyncStream<PushNotificationToken> = client.tokenUpdates()
    let payload = Data([0xaa, 0xbb])
    client.submitDeviceToken(payload)
    continuation.finish()

    var received: [PushNotificationToken] = []
    for await event in collected {
      received.append(event)
    }
    XCTAssertEqual(received, [.registered(payload)])
  }

  func test_customClient_submitFailureYieldsFailureCase() async {
    let (stream, continuation) = AsyncStream<PushNotificationToken>.makeStream()
    let client = PushNotificationClient(
      requestAuthorization: { false },
      registerForRemoteNotifications: { },
      submitDeviceToken: { _ in },
      submitRegistrationFailure: { error in continuation.yield(.failed(error.localizedDescription)) },
      tokenUpdates: { stream }
    )

    let collected = client.tokenUpdates()
    let underlying = NSError(domain: "apns", code: 3010, userInfo: [NSLocalizedDescriptionKey: "no entitlement"])
    client.submitRegistrationFailure(underlying)
    continuation.finish()

    var received: [PushNotificationToken] = []
    for await event in collected {
      received.append(event)
    }
    XCTAssertEqual(received, [.failed("no entitlement")])
  }
}
