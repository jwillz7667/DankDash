import SwiftUI
import ComposableArchitecture
import DankDashDesignSystem
import DankDashDomain
import DankDashFeatures

/// Single-product detail surface. Top: paged image carousel. Middle:
/// description + terpenes/effects badges + COA row. Bottom: pinned
/// "Add to cart" button (disabled when the listing is sold out or when
/// arrived from search without a listing pin).
struct ProductDetailView: View {
  @Bindable var store: StoreOf<ProductDetailFeature>
  @Dependency(\.cdnBaseURL) private var cdnBaseURL

  var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(alignment: .leading, spacing: DankSpacing.lg) {
          imageCarousel
          headerBlock
            .padding(.horizontal, DankSpacing.md)
          chemistryBlock
            .padding(.horizontal, DankSpacing.md)
          descriptionBlock
            .padding(.horizontal, DankSpacing.md)
          labResultsBlock
            .padding(.horizontal, DankSpacing.md)
          relatedBlock
        }
        .padding(.bottom, DankSpacing.xl)
      }
      addToCartBar
    }
    .navigationTitle(displayName)
    .navigationBarTitleDisplayMode(.inline)
    .background(DankColor.cream.ignoresSafeArea())
    .task {
      store.send(.task)
    }
    .sheet(isPresented: Binding(
      get: { store.coaFileURL != nil },
      set: { open in
        if !open { store.send(.coaDismissed) }
      }
    )) {
      if let url = store.coaFileURL {
        QuickLookPreview(fileURL: url, onDismiss: { store.send(.coaDismissed) })
      }
    }
    .alert(
      "Couldn't open certificate",
      isPresented: Binding(
        get: { store.coaError != nil },
        set: { open in
          if !open { store.send(.coaErrorDismissed) }
        }
      ),
      actions: {
        Button("OK", role: .cancel) { store.send(.coaErrorDismissed) }
      },
      message: {
        Text(store.coaError ?? "")
      }
    )
  }

  private var displayName: String {
    store.product?.name ?? store.productName
  }

  @ViewBuilder private var imageCarousel: some View {
    let keys = store.product?.imageKeys ?? []
    if keys.isEmpty {
      DankAsyncImage(
        imageKey: nil,
        cdnBaseURL: cdnBaseURL,
        contentMode: .fill,
        aspectRatio: 1
      )
      .frame(maxWidth: .infinity)
    } else {
      TabView {
        ForEach(keys, id: \.self) { key in
          DankAsyncImage(
            imageKey: key,
            cdnBaseURL: cdnBaseURL,
            contentMode: .fill,
            aspectRatio: 1
          )
        }
      }
      .tabViewStyle(.page(indexDisplayMode: keys.count > 1 ? .automatic : .never))
      .aspectRatio(1, contentMode: .fit)
      .frame(maxWidth: .infinity)
    }
  }

  @ViewBuilder private var headerBlock: some View {
    VStack(alignment: .leading, spacing: DankSpacing.xs) {
      HStack(spacing: DankSpacing.xs) {
        Circle()
          .fill(ProductTile.strainTint(store.product?.strainType))
          .frame(width: 10, height: 10)
          .accessibilityHidden(true)
        Text((store.product?.brand ?? store.brand).uppercased())
          .font(DankFont.caption)
          .tracking(1.0)
          .foregroundStyle(DankColor.Text.secondary)
        Spacer(minLength: 0)
      }
      Text(displayName)
        .font(DankFont.title)
        .foregroundStyle(DankColor.Text.primary)
      HStack(alignment: .firstTextBaseline, spacing: DankSpacing.sm) {
        Text(Self.formatPrice(store.priceCents))
          .font(DankFont.headline)
          .foregroundStyle(DankColor.primary)
        if let strain = store.product?.strainType {
          DankBadge(strain.rawValue.capitalized, tone: .neutral)
        }
        Spacer(minLength: 0)
      }
    }
  }

  @ViewBuilder private var chemistryBlock: some View {
    if let product = store.product {
      HStack(spacing: DankSpacing.sm) {
        chemistryCard(title: "THC", value: ProductTile.formatTHC(product.thcMgPerUnit, weight: product.weightGramsPerUnit))
        chemistryCard(title: "CBD", value: cbdLabel(product))
        if let count = product.servingCount, count > 0 {
          chemistryCard(title: "Servings", value: "\(count)")
        }
      }
    }
  }

  private func chemistryCard(title: String, value: String) -> some View {
    VStack(alignment: .leading, spacing: DankSpacing.xxs) {
      Text(title.uppercased())
        .font(DankFont.caption)
        .tracking(0.8)
        .foregroundStyle(DankColor.Text.muted)
      Text(value)
        .font(DankFont.body.weight(.semibold))
        .foregroundStyle(DankColor.Text.primary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(DankSpacing.sm)
    .background(DankColor.primary.opacity(0.06))
    .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
  }

  private func cbdLabel(_ product: Product) -> String {
    let mg = product.cbdMgPerUnit
    let weight = product.weightGramsPerUnit
    if weight > 0 {
      let percent = (mg / (weight * 1000)) * 100
      let s = Self.oneDecimalFormatter.string(from: percent as NSDecimalNumber) ?? "0.0"
      return "\(s)%"
    }
    return "\(Self.wholeFormatter.string(from: mg as NSDecimalNumber) ?? "0") mg"
  }

  @ViewBuilder private var descriptionBlock: some View {
    if let description = store.product?.description, !description.isEmpty {
      VStack(alignment: .leading, spacing: DankSpacing.xs) {
        Text("About")
          .font(DankFont.headline)
          .foregroundStyle(DankColor.Text.primary)
        Text(description)
          .font(DankFont.body)
          .foregroundStyle(DankColor.Text.secondary)
      }
    }
    let effects = store.product?.effectsTags ?? []
    let flavors = store.product?.flavorTags ?? []
    if !effects.isEmpty || !flavors.isEmpty {
      VStack(alignment: .leading, spacing: DankSpacing.sm) {
        if !effects.isEmpty {
          tagRow(title: "Effects", tags: effects)
        }
        if !flavors.isEmpty {
          tagRow(title: "Flavors", tags: flavors)
        }
      }
    }
  }

  private func tagRow(title: String, tags: [String]) -> some View {
    VStack(alignment: .leading, spacing: DankSpacing.xs) {
      Text(title.uppercased())
        .font(DankFont.caption)
        .tracking(0.8)
        .foregroundStyle(DankColor.Text.muted)
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: DankSpacing.xs) {
          ForEach(tags, id: \.self) { tag in
            DankBadge(tag, tone: .neutral)
          }
        }
      }
    }
  }

  @ViewBuilder private var labResultsBlock: some View {
    if let lab = store.headlineLabResult {
      VStack(alignment: .leading, spacing: DankSpacing.xs) {
        Text("Lab tested")
          .font(DankFont.headline)
          .foregroundStyle(DankColor.Text.primary)
        VStack(alignment: .leading, spacing: DankSpacing.xs) {
          HStack {
            Text("By \(lab.labName)")
              .font(DankFont.bodySmall)
              .foregroundStyle(DankColor.Text.secondary)
            Spacer()
            Text(lab.testedAt)
              .font(DankFont.caption)
              .foregroundStyle(DankColor.Text.muted)
          }
          if let passed = lab.contaminantsPassed {
            DankBadge(passed ? "Contaminants passed" : "Contaminants failed", tone: passed ? .success : .danger)
          }
          DankButton(
            store.isCoaDownloading ? "Loading certificate…" : "View certificate of analysis",
            style: .secondary,
            size: .medium,
            isLoading: store.isCoaDownloading,
            action: { store.send(.coaButtonTapped) }
          )
          .padding(.top, DankSpacing.xxs)
        }
        .padding(DankSpacing.sm)
        .background(DankColor.primary.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
      }
    }
  }

  @ViewBuilder private var relatedBlock: some View {
    if !store.relatedProducts.isEmpty {
      VStack(alignment: .leading, spacing: DankSpacing.sm) {
        SectionHeader(eyebrow: "You might like", title: "Related products")
          .padding(.horizontal, DankSpacing.md)
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: DankSpacing.sm) {
            ForEach(store.relatedProducts) { related in
              Button {
                store.send(.relatedTapped(productId: related.id))
              } label: {
                VStack(alignment: .leading, spacing: DankSpacing.xs) {
                  DankAsyncImage(
                    imageKey: related.imageKeys.first,
                    cdnBaseURL: cdnBaseURL,
                    contentMode: .fill,
                    aspectRatio: 1
                  )
                  .frame(width: 140, height: 140)
                  .clipShape(RoundedRectangle(cornerRadius: DankRadius.md, style: .continuous))
                  Text(related.brand.uppercased())
                    .font(DankFont.caption)
                    .tracking(0.8)
                    .foregroundStyle(DankColor.Text.secondary)
                    .lineLimit(1)
                  Text(related.name)
                    .font(DankFont.bodySmall.weight(.semibold))
                    .foregroundStyle(DankColor.Text.primary)
                    .lineLimit(2)
                }
                .frame(width: 140)
              }
              .buttonStyle(.plain)
              .accessibilityElement(children: .combine)
              .accessibilityLabel("\(related.brand) \(related.name)")
            }
          }
          .padding(.horizontal, DankSpacing.md)
        }
      }
    }
  }

  private var addToCartBar: some View {
    HStack(spacing: DankSpacing.sm) {
      VStack(alignment: .leading, spacing: 0) {
        Text(Self.formatPrice(store.priceCents))
          .font(DankFont.headline)
          .foregroundStyle(DankColor.Text.primary)
        Text(stockLabel)
          .font(DankFont.caption)
          .foregroundStyle(stockColor)
      }
      Spacer()
      DankButton(
        store.canAddToCart ? "Add to cart" : "Unavailable",
        style: .primary,
        size: .large,
        isDisabled: !store.canAddToCart,
        action: { store.send(.addToCartTapped) }
      )
      .frame(maxWidth: 180)
    }
    .padding(DankSpacing.md)
    .background(DankColor.cream)
    .overlay(alignment: .top) {
      Rectangle()
        .fill(DankColor.primary.opacity(0.08))
        .frame(height: 1)
    }
  }

  private var stockLabel: String {
    if store.maxAvailable <= 0 { return "Sold out" }
    if store.maxAvailable < 5 { return "Only \(store.maxAvailable) left" }
    return "In stock"
  }

  private var stockColor: Color {
    if store.maxAvailable <= 0 { return DankColor.Semantic.danger }
    if store.maxAvailable < 5 { return DankColor.Semantic.warning }
    return DankColor.Text.muted
  }

  static func formatPrice(_ cents: Int) -> String {
    let dollars = Double(cents) / 100
    let f = NumberFormatter()
    f.numberStyle = .currency
    f.currencyCode = "USD"
    return f.string(from: NSNumber(value: dollars)) ?? "$\(dollars)"
  }

  private static let oneDecimalFormatter: NumberFormatter = {
    let f = NumberFormatter()
    f.minimumFractionDigits = 1
    f.maximumFractionDigits = 1
    return f
  }()

  private static let wholeFormatter: NumberFormatter = {
    let f = NumberFormatter()
    f.minimumFractionDigits = 0
    f.maximumFractionDigits = 0
    return f
  }()
}
