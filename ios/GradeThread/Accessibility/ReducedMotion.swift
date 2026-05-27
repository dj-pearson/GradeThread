import SwiftUI
import UIKit

/// Tiny helper that honours iOS's "Reduce Motion" accessibility setting
/// across the views that animate. SwiftUI doesn't yet have a built-in
/// "respect Reduce Motion" modifier; the pattern is:
///
///     .animation(ReducedMotion.animation(.easeInOut), value: someValue)
///
/// When Reduce Motion is off, the supplied animation runs normally.
/// When it's on, we hand SwiftUI `nil` and the state change snaps into
/// place without interpolation.
@MainActor
public enum ReducedMotion {
    /// Live system setting. Reads on every access so an in-session
    /// toggle (rare but possible) takes effect on the next animation
    /// without an app restart.
    public static var isEnabled: Bool {
        UIAccessibility.isReduceMotionEnabled
    }

    /// Wrapper for `.animation(_:value:)` modifiers. Returns nil when
    /// Reduce Motion is on so SwiftUI skips interpolation entirely.
    public static func animation(_ animation: Animation) -> Animation? {
        isEnabled ? nil : animation
    }

    /// Optional duration multiplier for callers that build their own
    /// timed transitions (e.g. tween-style animations). Reduce Motion
    /// → 0 collapses the duration; off → 1 leaves it alone.
    public static var durationScale: Double {
        isEnabled ? 0 : 1
    }
}

// MARK: - SwiftUI sugar

public extension View {
    /// Convenience for the most common pattern: `.animation(spring, value:)`
    /// but respect Reduce Motion automatically.
    @ViewBuilder
    func accessibleAnimation<V: Equatable>(
        _ animation: Animation,
        value: V
    ) -> some View {
        self.animation(ReducedMotion.animation(animation), value: value)
    }
}
