import SwiftUI

/// CDN-aware AsyncImage wrapper with a skeleton placeholder and a single
/// retry on failure. The consumer passes a raw R2 image key plus a CDN
/// base URL; this component composes the URL and renders. Centralizing
/// the URL composition prevents a future site from hardcoding the CDN
/// origin.
public struct DankAsyncImage: View {
  public enum ContentMode: Sendable {
    case fit, fill
  }

  private let imageKey: String?
  private let cdnBaseURL: URL?
  private let contentMode: ContentMode
  private let aspectRatio: CGFloat?

  @State private var attempt: Int = 0

  public init(
    imageKey: String?,
    cdnBaseURL: URL?,
    contentMode: ContentMode = .fill,
    aspectRatio: CGFloat? = nil
  ) {
    self.imageKey = imageKey
    self.cdnBaseURL = cdnBaseURL
    self.contentMode = contentMode
    self.aspectRatio = aspectRatio
  }

  public var body: some View {
    Group {
      if let url = resolvedURL {
        AsyncImage(url: url, transaction: Transaction(animation: .easeOut(duration: 0.2))) { phase in
          switch phase {
          case .empty:
            skeleton
          case .success(let image):
            image
              .resizable()
              .aspectRatio(contentMode: swiftUIContentMode)
          case .failure:
            retryFallback
          @unknown default:
            skeleton
          }
        }
        .id(attempt)
      } else {
        skeleton
      }
    }
    .modifier(AspectRatioModifier(ratio: aspectRatio, contentMode: swiftUIContentMode))
    .clipped()
    .accessibilityHidden(true)
  }

  private var resolvedURL: URL? {
    guard let imageKey, !imageKey.isEmpty, let cdnBaseURL else { return nil }
    return cdnBaseURL.appending(path: imageKey)
  }

  private var swiftUIContentMode: SwiftUI.ContentMode {
    contentMode == .fit ? .fit : .fill
  }

  private var skeleton: some View {
    Rectangle()
      .fill(DankColor.primary.opacity(0.08))
      .overlay(
        LinearGradient(
          colors: [
            DankColor.primary.opacity(0.04),
            DankColor.primary.opacity(0.16),
            DankColor.primary.opacity(0.04),
          ],
          startPoint: .leading,
          endPoint: .trailing
        )
        .opacity(0.6)
      )
  }

  private var retryFallback: some View {
    ZStack {
      DankColor.primary.opacity(0.08)
      VStack(spacing: DankSpacing.xs) {
        Image(systemName: "leaf")
          .foregroundStyle(DankColor.primary.opacity(0.5))
        Button("Retry") { attempt &+= 1 }
          .font(DankFont.caption)
          .foregroundStyle(DankColor.primary)
      }
    }
  }
}

private struct AspectRatioModifier: ViewModifier {
  let ratio: CGFloat?
  let contentMode: SwiftUI.ContentMode

  func body(content: Content) -> some View {
    if let ratio {
      content.aspectRatio(ratio, contentMode: contentMode)
    } else {
      content
    }
  }
}

#Preview {
  VStack(spacing: DankSpacing.md) {
    DankAsyncImage(imageKey: "products/x.jpg", cdnBaseURL: URL(string: "https://cdn.example"), aspectRatio: 1)
      .frame(width: 200, height: 200)
    DankAsyncImage(imageKey: nil, cdnBaseURL: nil, aspectRatio: 16.0 / 9.0)
      .frame(width: 240, height: 135)
  }
  .padding()
  .background(DankColor.cream)
}
