// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DankDashKit",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [
    .library(name: "DankDashDomain", targets: ["DankDashDomain"]),
    .library(name: "DankDashDesignSystem", targets: ["DankDashDesignSystem"]),
    .library(name: "DankDashStorage", targets: ["DankDashStorage"]),
    .library(name: "DankDashNetwork", targets: ["DankDashNetwork"]),
    .library(name: "DankDashFeatures", targets: ["DankDashFeatures"]),
  ],
  dependencies: [
    .package(url: "https://github.com/pointfreeco/swift-composable-architecture", from: "1.15.0"),
    .package(url: "https://github.com/pointfreeco/swift-snapshot-testing", from: "1.17.0"),
  ],
  targets: [
    .target(name: "DankDashDomain"),
    .target(name: "DankDashDesignSystem"),
    .target(
      name: "DankDashStorage",
      dependencies: ["DankDashDomain"]
    ),
    .target(
      name: "DankDashNetwork",
      dependencies: ["DankDashDomain"]
    ),
    .target(
      name: "DankDashFeatures",
      dependencies: [
        "DankDashDomain",
        "DankDashStorage",
        "DankDashNetwork",
        .product(name: "ComposableArchitecture", package: "swift-composable-architecture"),
      ]
    ),
    .testTarget(name: "DankDashDomainTests", dependencies: ["DankDashDomain"]),
    .testTarget(
      name: "DankDashDesignSystemTests",
      dependencies: [
        "DankDashDesignSystem",
        .product(name: "SnapshotTesting", package: "swift-snapshot-testing"),
      ]
    ),
    .testTarget(
      name: "DankDashStorageTests",
      dependencies: ["DankDashStorage", "DankDashDomain"]
    ),
    .testTarget(
      name: "DankDashNetworkTests",
      dependencies: ["DankDashNetwork", "DankDashDomain"]
    ),
    .testTarget(
      name: "DankDashFeaturesTests",
      dependencies: [
        "DankDashFeatures",
        .product(name: "ComposableArchitecture", package: "swift-composable-architecture"),
      ]
    ),
  ],
  swiftLanguageModes: [.v6]
)
