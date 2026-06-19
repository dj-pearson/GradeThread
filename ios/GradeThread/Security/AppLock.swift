import Foundation
import LocalAuthentication
import Observation

/// US-696 — optional Face ID / passcode lock for a financial + PII app. When
/// the user opts in, returning to the foreground (or a cold launch) requires a
/// successful `LAContext` evaluation before the main shell renders; until then
/// the privacy cover stays up. The privacy cover (US-663) only hides the App
/// Switcher thumbnail — this gates actual re-entry.
///
/// US-1016 — two auth policies are supported:
///
///   * `.biometricsOrPasscode` (default, `.deviceOwnerAuthentication`): Face ID,
///     Touch ID, **or** the device passcode satisfies the lock. The passcode is
///     the anti-lockout fallback — biometrics can lock out after repeated
///     failures, but the passcode always works.
///   * `.biometricsOnly` (`.deviceOwnerAuthenticationWithBiometrics`): only Face
///     ID / Touch ID is accepted; the OS will NOT fall back to the passcode.
///     Repeated failures lock out biometrics, so for anti-lockout safety we fall
///     back to the device passcode (`.deviceOwnerAuthentication`) when biometrics
///     are unavailable rather than silently bypassing the lock.
///
/// Anti-lockout invariant: a device with **no** owner-authentication method
/// configured at all auto-unlocks (we never strand the user). That branch is
/// telemetered (`onAntiLockoutUnlock`) so we can see how often it fires.
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

    /// Which authentication policy the lock evaluates.
    public enum AuthMode: String, Equatable {
        /// `.deviceOwnerAuthentication` — biometrics OR the device passcode.
        case biometricsOrPasscode
        /// `.deviceOwnerAuthenticationWithBiometrics` — biometrics only, no
        /// automatic passcode fallback from the OS.
        case biometricsOnly
    }

    private static let enabledKey = "com.gradethread.app.applock.enabled"
    private static let biometricsOnlyKey = "com.gradethread.app.applock.biometricsOnly"

    /// Returns whether the device can evaluate the given auth mode. Injected for
    /// tests.
    private let canEvaluate: (AuthMode) -> Bool
    /// Performs the actual evaluation for the given mode; returns true on
    /// success. Injected.
    private let evaluate: (AuthMode, String) async throws -> Bool
    /// Fired when the lock auto-unlocks because the device has no usable auth
    /// method (anti-lockout). Defaults to a telemetry event; injected so tests
    /// can observe it.
    private let onAntiLockoutUnlock: (AuthMode) -> Void

    /// Guards against re-entrant prompts: presenting the system auth UI drives
    /// the app to `.inactive`/`.active`, which would otherwise re-trigger auth.
    private var isAuthenticating = false

    public private(set) var state: State

    public init(
        canEvaluate: @escaping (AuthMode) -> Bool = AppLock.deviceCanEvaluate,
        evaluate: @escaping (AuthMode, String) async throws -> Bool = AppLock.deviceEvaluate,
        onAntiLockoutUnlock: @escaping (AuthMode) -> Void = AppLock.reportAntiLockoutUnlock
    ) {
        self.canEvaluate = canEvaluate
        self.evaluate = evaluate
        self.onAntiLockoutUnlock = onAntiLockoutUnlock
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

    /// Opt-in to the stricter biometrics-only policy. Off by default so the
    /// device passcode satisfies the lock (anti-lockout). Takes effect on the
    /// next authentication; no immediate state change.
    public var biometricsOnly: Bool {
        get { UserDefaults.standard.bool(forKey: Self.biometricsOnlyKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.biometricsOnlyKey) }
    }

    /// The currently configured auth mode.
    public var mode: AuthMode { biometricsOnly ? .biometricsOnly : .biometricsOrPasscode }

    /// True when the device has any owner-authentication method configured
    /// (biometrics OR passcode), so Settings can avoid offering a lock that
    /// would trap the user out.
    public var isAvailable: Bool { canEvaluate(.biometricsOrPasscode) }

    /// True when the device has enrolled biometrics available right now, so
    /// Settings can decide whether to offer the biometrics-only option.
    public var biometricsAvailable: Bool { canEvaluate(.biometricsOnly) }

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

        // Resolve the policy we can actually evaluate, applying anti-lockout
        // rules. `nil` means the device has no usable auth method at all.
        guard let activeMode = resolveAuthMode() else {
            // No biometrics/passcode set up — don't strand the user.
            state = .unlocked
            onAntiLockoutUnlock(mode)
            return
        }
        isAuthenticating = true
        defer { isAuthenticating = false }
        do {
            state = try await evaluate(activeMode, reason) ? .unlocked : .locked
        } catch {
            state = .locked
        }
    }

    /// Picks the mode to actually evaluate, or `nil` when the device has no
    /// usable auth method (→ anti-lockout unlock). In biometrics-only mode,
    /// when biometrics are unavailable or locked out we fall back to the device
    /// passcode rather than stranding OR silently bypassing the lock — only a
    /// device with NO auth at all unlocks.
    private func resolveAuthMode() -> AuthMode? {
        if canEvaluate(mode) { return mode }
        if mode == .biometricsOnly, canEvaluate(.biometricsOrPasscode) {
            return .biometricsOrPasscode
        }
        return nil
    }

    // MARK: - Real device implementation

    // `nonisolated` because `deviceCanEvaluate`/`deviceEvaluate` below are
    // nonisolated (used as default args) and call this; the @MainActor class
    // isolation would otherwise make it a "call in a synchronous nonisolated
    // context" error. Pure switch over an enum, so it's safe off the main actor.
    private nonisolated static func policy(for mode: AuthMode) -> LAPolicy {
        switch mode {
        case .biometricsOrPasscode: return .deviceOwnerAuthentication
        case .biometricsOnly: return .deviceOwnerAuthenticationWithBiometrics
        }
    }

    // `nonisolated` so they can be used as default arguments (evaluated in a
    // nonisolated context) and assigned to the nonisolated closure properties
    // above. Each spins up a fresh LAContext and is safe off the main actor;
    // without this the @MainActor class isolation makes the default-arg
    // references at init a "call in a synchronous nonisolated context" error.
    public nonisolated static func deviceCanEvaluate(_ mode: AuthMode) -> Bool {
        var error: NSError?
        return LAContext().canEvaluatePolicy(policy(for: mode), error: &error)
    }

    public nonisolated static func deviceEvaluate(_ mode: AuthMode, _ reason: String) async throws -> Bool {
        try await LAContext().evaluatePolicy(policy(for: mode), localizedReason: reason)
    }

    /// Default anti-lockout telemetry. `nonisolated` for use as a default
    /// argument; the call sites run on the main actor (`authenticate`), so
    /// `assumeIsolated` is sound.
    public nonisolated static func reportAntiLockoutUnlock(_ mode: AuthMode) {
        MainActor.assumeIsolated {
            Telemetry.event("app_lock_anti_lockout_unlock", props: ["mode": mode.rawValue])
            Telemetry.breadcrumb(
                "App lock auto-unlocked: no usable auth method for mode \(mode.rawValue)",
                category: "security"
            )
        }
    }
}
