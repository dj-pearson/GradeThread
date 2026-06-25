import Foundation

/// US-1157: pure decision logic for per-scene state restoration on iPad
/// multi-window. Kept free of SwiftUI/UIKit so it unit-tests without a
/// simulator — the `@SceneStorage`-backed wiring lives in `MainShell`
/// (`ContentView.swift`) and `ItemCanvasSceneHost`.
///
/// Two values are persisted per scene: the resting ``AppSection`` (which
/// tab/sidebar item the window rests on) and the focused inventory item id
/// (the canvas a window currently shows). The `.add` pseudo-section is never
/// a resting selection — tapping it fires the add flow and the previous
/// selection is restored synchronously — so it is excluded from persistence
/// and ignored on restore.
enum SceneRestoration {
    /// Decode a persisted raw section value into a restorable ``AppSection``.
    /// Returns `nil` for an empty/unknown value (nothing to restore) or the
    /// transient `.add` pseudo-section.
    static func restoreSection(from raw: String) -> AppSection? {
        guard let section = AppSection(rawValue: raw), section != .add else {
            return nil
        }
        return section
    }

    /// The raw value to persist for a section, or `nil` when the section must
    /// not be stored (the transient `.add` pseudo-section).
    static func persistableRaw(for section: AppSection) -> String? {
        section == .add ? nil : section.rawValue
    }

    /// Whether a non-empty focused-item id should be restored. A blank id
    /// means no canvas was open when the scene was torn down.
    static func restorableItemId(from raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
