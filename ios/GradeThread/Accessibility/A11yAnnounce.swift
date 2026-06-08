import SwiftUI
import UIKit

/// US-701 — a tiny reusable wrapper so async outcomes (grade complete, eBay
/// sync done, Scout scan finished, form saved) announce themselves to VoiceOver
/// instead of silently swapping content (WCAG 4.1.3 Status Messages). Prior to
/// this only PhotoIntakeView announced anything; every other long-running
/// result was inaudible.
enum A11yAnnounce {

    /// Posts a VoiceOver announcement. No-op when VoiceOver isn't running, so
    /// it's safe to call unconditionally from result handlers.
    @MainActor
    static func announce(_ message: String) {
        guard UIAccessibility.isVoiceOverRunning, !message.isEmpty else { return }
        // Defer a beat so the announcement lands after SwiftUI commits the
        // content change, otherwise VoiceOver can drop it.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            AccessibilityNotification.Announcement(message).post()
        }
    }

    /// Signals that the screen's contents changed substantially, moving
    /// VoiceOver focus to the start of the new content (or to `focusing` text).
    @MainActor
    static func screenChanged(focusing message: String? = nil) {
        guard UIAccessibility.isVoiceOverRunning else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            UIAccessibility.post(notification: .screenChanged, argument: message)
        }
    }
}
