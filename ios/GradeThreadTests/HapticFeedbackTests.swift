import XCTest
@testable import GradeThread

@MainActor
final class HapticFeedbackTests: XCTestCase {

    // MARK: - Smoke tests

    // UIImpactFeedbackGenerator + UINotificationFeedbackGenerator
    // don't expose a way to verify a tap actually fired on the simulator.
    // These tests verify the helpers are callable + don't crash so a
    // refactor that drops a generator type doesn't go unnoticed in CI.

    func test_light_doesNotCrash() {
        HapticFeedback.light()
    }

    func test_medium_doesNotCrash() {
        HapticFeedback.medium()
    }

    func test_success_doesNotCrash() {
        HapticFeedback.success()
    }

    func test_warning_doesNotCrash() {
        HapticFeedback.warning()
    }

    func test_error_doesNotCrash() {
        HapticFeedback.error()
    }

    func test_playShutterSound_doesNotCrash() {
        // AudioServicesPlaySystemSound is fire-and-forget on the
        // simulator (silent). Validates the symbol resolves.
        HapticFeedback.playShutterSound()
    }

    // MARK: - AppRouter.haptic alias

    func test_appRouterHaptic_routes_through_helper() {
        // Smoke: AppRouter.haptic() still compiles + runs after the
        // US-195 refactor that moved the implementation to
        // HapticFeedback.light(). If this stops compiling, the call
        // sites scattered across the app will too.
        AppRouter.haptic()
    }
}
