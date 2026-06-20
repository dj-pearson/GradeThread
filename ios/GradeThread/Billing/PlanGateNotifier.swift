import Foundation
import Observation

/// App-wide sink for the plan-gate signals decoded by ``EdgeAPI`` (US-805).
/// The root shell observes this and presents the upgrade prompt (hard 402 cap)
/// or a non-blocking soft banner (80% `X-Plan-Warning`). Centralizing it here
/// means a 402 from *any* flipdesk / grading / AI call surfaces an upgrade path
/// without each call site wiring its own handling.
@MainActor
@Observable
final class PlanGateNotifier {
    static let shared = PlanGateNotifier()

    /// Set when a hard cap blocks an action → drives the upgrade-prompt sheet.
    var activePrompt: PlanGateError?
    /// Set when a soft warning should surface → drives the transient banner.
    var activeWarning: PlanWarning?

    /// Caps already warned about this session, so the soft banner fires at most
    /// once per cap kind per launch (mirrors the web's once-per-month dedup at a
    /// session granularity — the app is short-lived vs. a long web session).
    private var warnedKindsThisSession: Set<String> = []

    init() {}

    /// Present the hard-cap upgrade prompt. Always shown (a blocked action needs
    /// resolution); the sheet's identity de-dups same-cap churn.
    func present(_ gate: PlanGateError) {
        activePrompt = gate
        Telemetry.event("upgrade_prompt_shown")
    }

    /// Surface the soft warning if it clears the user's configured threshold and
    /// hasn't already fired for this cap this session.
    func presentWarning(_ warning: PlanWarning) {
        guard Self.shouldSurface(
            warning: warning,
            threshold: AppPreferences.usageAlertThreshold,
            alreadyWarnedKinds: warnedKindsThisSession
        ) else { return }
        warnedKindsThisSession.insert(warning.kind)
        activeWarning = warning
        Telemetry.event("upgrade_soft_warning_shown")
    }

    /// Pure gating decision (testable without the MainActor singleton): show the
    /// banner only when the cap crossed the user's threshold and we haven't
    /// already warned about this cap kind.
    static func shouldSurface(
        warning: PlanWarning,
        threshold: UsageAlertThreshold,
        alreadyWarnedKinds: Set<String>
    ) -> Bool {
        guard !alreadyWarnedKinds.contains(warning.kind) else { return false }
        guard warning.limit > 0 else { return false }
        return warning.pct >= threshold.fraction
    }

    /// For tests: reset the per-session dedup so each case starts clean.
    func resetForTesting() {
        warnedKindsThisSession.removeAll()
        activePrompt = nil
        activeWarning = nil
    }

    // MARK: - Bridges from the EdgeAPI actor

    /// `@Sendable` hop onto the MainActor so the actor-isolated ``EdgeAPI`` can
    /// publish a decoded 402 without crossing isolation by hand at the call site.
    /// `nonisolated` so the nonisolated ``EdgeAPI/shared`` initializer can use
    /// these as default arguments; the hop to the singleton happens inside the
    /// `@MainActor` task.
    nonisolated static let publish: @Sendable (PlanGateError) -> Void = { gate in
        Task { @MainActor in PlanGateNotifier.shared.present(gate) }
    }

    nonisolated static let publishWarning: @Sendable (PlanWarning) -> Void = { warning in
        Task { @MainActor in PlanGateNotifier.shared.presentWarning(warning) }
    }
}
