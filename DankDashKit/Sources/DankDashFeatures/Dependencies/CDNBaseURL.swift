import Foundation
import ComposableArchitecture

/// Process-wide CDN base URL used to compose image / document URLs from
/// the raw R2 keys the API returns (`heroImageKey`, `coaDocumentKey`,
/// `imageKeys`, etc.). The app target overrides this at boot from the
/// `CDN_BASE_URL` environment value; reducers read it through the
/// dependency surface so tests can substitute a known fixture.
///
/// A `nil` value means the CDN isn't configured — view components
/// degrade to placeholder graphics and the COA flow surfaces an error.
public enum CDNBaseURL {
  /// Default that ships in the development environment so the test
  /// surface and the previews both have something to compose against.
  public static let devDefault: URL? = URL(string: "https://cdn.dankdash.com")
}

private enum CDNBaseURLKey: DependencyKey {
  static let liveValue: URL? = CDNBaseURL.devDefault
  static let testValue: URL? = CDNBaseURL.devDefault
}

public extension DependencyValues {
  /// The CDN base URL active in this dependency scope. Reducers compose
  /// document URLs by `base.appending(path: key)`; views read this same
  /// value when constructing `DankAsyncImage`.
  var cdnBaseURL: URL? {
    get { self[CDNBaseURLKey.self] }
    set { self[CDNBaseURLKey.self] = newValue }
  }
}
