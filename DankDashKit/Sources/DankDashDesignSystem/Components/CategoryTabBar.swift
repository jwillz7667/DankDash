import SwiftUI

/// Sticky horizontal category strip used on the storefront. Each tab is
/// a pill that highlights when selected. The selection binding is what
/// the storefront reducer drives, so the bar is fully reusable wherever
/// horizontal one-of-many category navigation is needed.
public struct CategoryTabBar: View {
  public struct Item: Identifiable, Hashable, Sendable {
    public let id: String
    public let title: String
    public let count: Int?

    public init(id: String, title: String, count: Int? = nil) {
      self.id = id
      self.title = title
      self.count = count
    }
  }

  private let items: [Item]
  @Binding private var selection: String?

  public init(items: [Item], selection: Binding<String?>) {
    self.items = items
    self._selection = selection
  }

  public var body: some View {
    ScrollViewReader { proxy in
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: DankSpacing.xs) {
          FacetPill(
            title: "All",
            isSelected: selection == nil,
            action: {
              selection = nil
            }
          )
          .id("all")
          ForEach(items) { item in
            FacetPill(
              title: item.title,
              count: item.count,
              isSelected: selection == item.id,
              action: {
                selection = item.id
              }
            )
            .id(item.id)
          }
        }
        .padding(.horizontal, DankSpacing.md)
        .padding(.vertical, DankSpacing.xs)
      }
      .onChange(of: selection) { _, newValue in
        guard let newValue else { return }
        withAnimation(.easeInOut(duration: 0.2)) {
          proxy.scrollTo(newValue, anchor: .center)
        }
      }
    }
    .accessibilityLabel("Categories")
  }
}

#Preview {
  StatefulPreviewWrapper(String?.none) { selection in
    CategoryTabBar(
      items: [
        .init(id: "flower", title: "Flower", count: 24),
        .init(id: "vape", title: "Vape", count: 12),
        .init(id: "edible", title: "Edibles", count: 9),
        .init(id: "preroll", title: "Pre-rolls"),
      ],
      selection: selection
    )
    .background(DankColor.cream)
  }
}

private struct StatefulPreviewWrapper<Value, Content: View>: View {
  @State private var value: Value
  private let content: (Binding<Value>) -> Content

  init(_ value: Value, @ViewBuilder content: @escaping (Binding<Value>) -> Content) {
    self._value = State(initialValue: value)
    self.content = content
  }

  var body: some View { content($value) }
}
