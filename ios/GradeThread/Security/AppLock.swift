import Foundation
import LocalAuthentication
import Observation

/// US-696 — optional Face ID / passcode lock for a financial + PII app. When
/// the user opts in, returning to the foreground (or a cold launch) requires a
/// successful `LAContext` evaluation before the main shell renders; until then
/// the privacy cover stays up. The privacy cover (US-663) only hides the App
/// Switcher thumbnail — this gates actual re-entry.
///
/// The biometric/passcode evaluation is injected so the gating state machine is
/// unit-testable without a real `LAContext`.
@MainActor
@Observable
public final class AppLock {

    public enum State: Equatable {
        /// Content is visible.
        case unlocked
        /// Locked — show the unlock cover, content hidden.
        case locked
    }

    private static let enabledKey = "com.gradethread.app.applock.enabled"

    /// Returns whether the device can evaluate owner authentication
    /// (biometrics OR passcode). Injected for tests.
    private let canEvaluate: () -> Bool
    /// Performs the actual evaluation; returns true on success. Injected.
    private let evaluate: (String) async throws -> Bool

    /// Guards against re-entrant prompts: presenting the system auth UI drives
    /// the app to `.inactive`/`.active`, which would otherwise re-trigger auth.
    private var isAuthenticating = false

    public private(set) var state: State

    public init(
        canEvaluate: @escaping () -> Bool = AppLock.deviceCanEvaluate,
        evaluate: @escaping (String) async throws -> Bool = AppLock.deviceEvaluate
    ) {
        self.canEvaluate = canEvaluate
        self.evaluate = evaluate
        // A cold launch with the lock enabled starts locked.
        self.state = UserDefaults.standard.bool(forKey: Self.enabledKey) ? .locked : .unlocked
    }

    /// User-facing opt-in toggle ("Require Face ID / passcode to open").
    public var isEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: Self.enabledKey) }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.enabledKey)
            // Turning it off unlocks immediately; turning it on leaves the
            // current session unlocked (the user is already here) and takes
            // effect on the next background → foreground transition.
            if !newValue { state = .unlocked }
        }
    }

    /// True when the device has any owner-authentication method configured, so
    /// Settings can avoid offering a lock that would trap the user out.
    public var isAvailable: Bool { canEvaluate() }

    /// Called when the app backgrounds: re-arm the lock if enabled.
    public func lockIfEnabled() {
        guard isEnabled, !isAuthenticating else { return }
        state = .locked
    }

    /// Prompts for biometric/passcode unlock. No-op when disabled or already
    /// authenticating. On failure the app stays locked so the cover remains.
    public func authenticate(reason: String = "Unlock GradeThread") async {
        guard isEnabled else { state = .unlocked; return }
        guard !isAuthenticating else { return }
        guard canEvaluate() else {
            // No biometrics/passcode set up — don't strand the user.
            state = .unlocked
            return
        }
        isAuthenticating = true
        defer { isAuthenticating = false }
        do {
            state = try await evaluate(reason) ? .unlocked : .locked
        } catch {
            state = .locked
        }
    }

    // MARK: - Real device implementation

    // `nonisolated` so they can be used as default arguments (evaluated in a
    // nonisolated context) and assigned to the nonisolated closure properties
    // above. Each spins up a fresh LAContext and is safe off the main actor;
    // without this the @MainActor class isolation makes the default-arg
    // references at init a "call in a synchronous nonisolated context" error.
    public nonisolated static func deviceCanEvaluate() -> Bool {
        var error: NSError?
        return LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
    }

    public nonisolated static func deviceEvaluate(_ reason: String) async throws -> Bool {
        try await LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
    }
}
