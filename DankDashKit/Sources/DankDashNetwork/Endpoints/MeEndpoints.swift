import Foundation

public enum MeEndpoints {
  public static func current() -> Endpoint<UserSummaryDTO> {
    Endpoint(method: .GET, path: "v1/me", requiresAuth: true)
  }
}
