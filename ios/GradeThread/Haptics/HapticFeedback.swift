import AudioToolbox
import UIKit

/// Typed wrapper around UIKit's haptic generators + the iOS shutter
/// sound. Centralises every feedback site so audit + tuning happens in
/// one place rather than spread across the views.
@MainActor
public enum HapticFeedback {

    /// Light impact — tab changes, chip taps, anywhere the user
    /// confirmed an inconsequential choice.
    public static func light() {
        play(impact: .light)
    }

    /// Medium impact — photo capture, sheet dismiss with a real action,
    /// anywhere the user committed to something tangible.
    public static func medium() {
        play(impact: .medium)
    }

    /// Success notification — publish push, save success, completed
    /// background sync that landed new sales. Pairs well with a
    /// checkmark on screen.
    public static func success() {
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        generator.notificationOccurred(.success)
    }

    /// Warning notification — non-blocking issues like 'token expiring
    /// soon' that need attention but don't block the flow.
    public static func warning() {
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        generator.notificationOccurred(.warning)
    }

    /// Error notification — sync failures, publish rejected, anything
    /// that stopped the user's flow. Pairs with a red toast.
    public static func error() {
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        generator.notificationOccurred(.error)
    }

    /// Plays the standard iOS shutter sound. Mandatory in some locales
    /// (JP, KR) — using the system sound id keeps us compliant on every
    /// device. 1108 is the canonical shutter; the SystemSoundID API is
    /// older C-style but it's still the supported route for short
    /// system effects.
    public static func playShutterSound() {
        AudioServicesPlaySystemSound(1108)
    }

    // MARK: - Internals

    private static func play(impact style: UIImpactFeedbackGenerator.FeedbackStyle) {
        // Prepare-then-impact reduces latency between tap and tap-back.
        // Apple's HIG recommends prepare() for every feedback site.
        let generator = UIImpactFeedbackGenerator(style: style)
        generator.prepare()
        generator.impactOccurred()
    }
}
