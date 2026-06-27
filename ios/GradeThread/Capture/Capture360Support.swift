import Foundation
#if canImport(ARKit)
import ARKit
#endif

// US-1281: Verified 360 — device capability + capture-mode decision.
//
// PURE decision logic (no ARKit capture session) so it unit-tests on CI. It
// answers AC1/AC2: which capture mode to OFFER on this device, and whether a
// completed on-device capture's metrics would qualify for the badge (mirroring
// the server thresholds in services/edge-functions/src/lib/verified-360.ts so the
// UI can preview the outcome — the server remains authoritative).
//
// The full guided photogrammetry/LiDAR capture UI (ObjectCaptureSession) is the
// deliberately-deferred "full build" (see ios/VERIFIED_360_SPIKE.md); it needs
// real-device QA before it ships. Verified 360 is NEVER required — on any device
// that cannot do it, `resolveMode` falls back to the 2D zone-coverage path
// (US-1276) and the seller simply never sees the 360 option.

/// The capture path offered to the seller.
enum Capture360Mode: String, Equatable {
    /// Premium guided photogrammetric / LiDAR true-geometric capture.
    case verified360
    /// The universal fallback: ordinary 2D photos scored by zone coverage (US-1276).
    case zoneCoverage2D
}

/// What this device can do, probed at runtime (never hard-coded by model).
struct Capture360Capability: Equatable {
    /// LiDAR / scene-reconstruction depth is available (strengthens 360 but is
    /// NOT required — multi-angle photogrammetry qualifies on its own).
    var hasDepth: Bool
    /// The device can run guided multi-angle photogrammetry (Object Capture).
    var supportsPhotogrammetry: Bool

    /// Verified 360 is offered whenever the device can do multi-angle
    /// photogrammetry; depth (LiDAR) makes it stronger but isn't a gate.
    var supportsVerified360: Bool { supportsPhotogrammetry }

    static let unsupported = Capture360Capability(
        hasDepth: false, supportsPhotogrammetry: false
    )
}

enum Capture360Support {
    /// Minimum distinct viewpoints a 360 capture must report. Mirrors the server's
    /// VERIFIED_360_MIN_ANGLES default.
    static let minAngles = 8
    /// Minimum device-computed surface coverage fraction (0...1). Mirrors the
    /// server's VERIFIED_360_MIN_COVERAGE default.
    static let minGeometricCoverage = 0.85

    /// AC1/AC2: offer Verified 360 only on a capable device; otherwise fall back
    /// to 2D zone coverage. 360 is never required.
    static func resolveMode(_ capability: Capture360Capability) -> Capture360Mode {
        capability.supportsVerified360 ? .verified360 : .zoneCoverage2D
    }

    /// Whether a completed on-device capture's metrics would earn the badge,
    /// mirroring the server-side `evaluateVerified360` thresholds so the UI can
    /// preview the outcome before submit. The server re-checks and is authoritative.
    static func qualifies(
        angles: Int,
        geometricCoverage: Double,
        captureComplete: Bool
    ) -> Bool {
        captureComplete
            && angles >= minAngles
            && geometricCoverage >= minGeometricCoverage
    }

    /// Runtime capability probe. ARKit-gated so the pure decision logic above
    /// still compiles + tests where ARKit is unavailable (Simulator/CI host).
    static func detectCapability() -> Capture360Capability {
        #if canImport(ARKit)
        guard ARWorldTrackingConfiguration.isSupported else {
            return .unsupported
        }
        let hasDepth = ARWorldTrackingConfiguration
            .supportsSceneReconstruction(.mesh)
        // Conservative launch gate: depth-backed (LiDAR) devices are the proven
        // tier. The photogrammetry-only (no-depth) tier stays behind real-device
        // QA per the spike, so today it tracks the depth probe.
        return Capture360Capability(
            hasDepth: hasDepth,
            supportsPhotogrammetry: hasDepth
        )
        #else
        return .unsupported
        #endif
    }
}
