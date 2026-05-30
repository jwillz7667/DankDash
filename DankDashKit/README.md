# DankDashKit

Local Swift package consumed by the DankDash iOS consumer app (and, later,
DankDasher). Houses the testable surface of the client: domain value types,
design system, keychain/biometric storage, networking, and TCA reducers. The
Xcode app target imports these libraries via `XCLocalSwiftPackageReference`
and supplies the view layer + composition root.

The package lives at the repo root (parallel to `DankDash/` and the future
`DankDasher/`) so it stays out of the lowercase `packages/` directory, which
is reserved for the TypeScript pnpm workspaces.

Library products:

| Product                | Purpose                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `DankDashDomain`       | Pure value types: `User`, `Email`, `Phone`, `DateOfBirth`, `Money`. No SwiftUI / Foundation-heavy code. |
| `DankDashDesignSystem` | Color/typography/spacing/radii tokens + SwiftUI components (`DankButton`, `DankCard`, `DankInput`, …).  |
| `DankDashStorage`      | Keychain + biometric `SecAccessControl` wrapper, `UserDefaults` helpers.                                |
| `DankDashNetwork`      | `APIClient` with single-shot 401→refresh→retry, auth + me endpoints, DTOs.                              |
| `DankDashFeatures`     | TCA reducers (`AgeGateFeature`, `LoginFeature`, …) with `@DependencyClient` wrappers around the rest.   |

## Running tests

```
swift test --package-path DankDashKit
```

## Adding a library

1. Add a `.target(...)` and matching `.testTarget(...)` in `Package.swift`.
2. Create `Sources/<Module>/` and `Tests/<Module>Tests/`.
3. Expose the library through `.library(name:, targets:)` so the iOS app can
   link it.

The iOS app's pbxproj already declares product dependencies for every library
above; new products need to be added to `DankDash.xcodeproj/project.pbxproj`
under `XCSwiftPackageProductDependency`.
