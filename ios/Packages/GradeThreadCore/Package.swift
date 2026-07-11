// swift-tools-version:5.9
import PackageDescription

// GradeThreadCore — platform-agnostic, Foundation-only logic extracted from the
// iOS app so it can be BUILT AND UNIT-TESTED on Linux (via `swift test`), without
// a Mac. The iOS app depends on this package (see ios/project.yml), so there is a
// single source of truth — no duplication.
//
// RULE: nothing in this target may import UIKit / SwiftUI / AVFoundation /
// StoreKit / SwiftData / Charts, etc. Only Foundation (which is available on
// Linux). Anything that needs those frameworks stays in the app target.
//
// The `platforms` line declares Apple minimums for the iOS app integration; it
// does NOT prevent Linux builds — `swift build` / `swift test` on Linux ignore it.
let package = Package(
    name: "GradeThreadCore",
    platforms: [.iOS(.v18), .macOS(.v13)],
    products: [
        .library(name: "GradeThreadCore", targets: ["GradeThreadCore"]),
    ],
    targets: [
        .target(name: "GradeThreadCore"),
        .testTarget(
            name: "GradeThreadCoreTests",
            dependencies: ["GradeThreadCore"]
        ),
    ]
)
