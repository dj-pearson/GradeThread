import Foundation
import Observation

/// Drives the general FlipDesk Automations surface (US-1135): loads trigger →
/// action rules, CRUDs them, toggles enablement, runs them on demand, and serves
/// per-rule dry-run + activity. Mirrors the phase + optimistic-action shape of
/// ``RepricingRulesStore``.
@MainActor
@Observable
final class AutomationsStore {
    enum Phase: Equatable {
        case loading
        case ready
        case failed(message: String)
    }

    private let service: AutomationsProviding

    var phase: Phase = .loading
    private(set) var rules: [AutomationRule] = []
    var actionError: String?
    var banner: String?
    var isRunning = false
    /// US-1175: rule ids with an in-flight enable/disable toggle, so the row can
    /// disable the switch and overlapping taps can't race conflicting PUTs.
    private(set) var togglingIds: Set<String> = []

    init(service: AutomationsProviding = AutomationsService()) {
        self.service = service
    }

    var isEmpty: Bool { rules.isEmpty }
    var hasActiveRule: Bool { rules.contains(where: \.isActive) }

    func load() async {
        phase = .loading
        do {
            rules = try await service.list()
            phase = .ready
        } catch {
            phase = .failed(message: error.localizedDescription)
        }
    }

    @discardableResult
    func save(_ draft: AutomationDraft, editingId: String?) async -> Bool {
        do {
            let input = draft.buildInput()
            let saved: AutomationRule
            if let editingId {
                saved = try await service.update(id: editingId, input)
            } else {
                saved = try await service.create(input)
            }
            if let i = rules.firstIndex(where: { $0.id == saved.id }) {
                rules[i] = saved
            } else {
                rules.append(saved)
            }
            return true
        } catch {
            actionError = error.localizedDescription
            return false
        }
    }

    func delete(_ rule: AutomationRule) async {
        rules.removeAll { $0.id == rule.id }
        do {
            try await service.delete(id: rule.id)
        } catch {
            actionError = error.localizedDescription
            await load()
        }
    }

    /// US-1175: flip a rule's active flag optimistically so the switch responds
    /// instantly, guard against overlapping toggles racing conflicting writes.
    /// US-1267: the save is now a MINIMAL `{isActive}` PATCH (not a full-replace
    /// PUT rebuilt from the pre-toggle snapshot), so it touches only the active
    /// flag — server-managed fields (last_run_at) and any concurrent edit to the
    /// rule's trigger/action/scope are preserved. On success we re-sync to the
    /// server's returned row; on failure we revert to server truth.
    func toggleActive(_ rule: AutomationRule) async {
        guard !togglingIds.contains(rule.id) else { return }
        togglingIds.insert(rule.id)
        defer { togglingIds.remove(rule.id) }

        let newValue = !rule.isActive
        if let i = rules.firstIndex(where: { $0.id == rule.id }) {
            rules[i].isActive = newValue
        }
        do {
            let saved = try await service.setActive(id: rule.id, isActive: newValue)
            // Re-sync to server truth (preserves last_run_at + concurrent edits).
            if let i = rules.firstIndex(where: { $0.id == saved.id }) {
                rules[i] = saved
            }
        } catch {
            actionError = error.localizedDescription
            // Revert the optimistic flip on failure.
            if let i = rules.firstIndex(where: { $0.id == rule.id }) {
                rules[i].isActive = !newValue
            }
        }
    }

    /// Run the caller's active rules immediately and refresh.
    func runNow() async {
        isRunning = true
        defer { isRunning = false }
        do {
            let result = try await service.run()
            guard result.ok else {
                banner = "Automations are currently turned off."
                return
            }
            banner = result.appliedCount > 0
                ? "Applied \(result.appliedCount) change\(result.appliedCount == 1 ? "" : "s") across \(result.scannedCount) listing\(result.scannedCount == 1 ? "" : "s")."
                : "Scanned \(result.scannedCount) listing\(result.scannedCount == 1 ? "" : "s") — nothing was due."
            do {
                rules = try await service.list()
            } catch {
                // The run succeeded; only the post-run refresh failed. Keep the
                // cached rules but breadcrumb so the stale view is diagnosable.
                Telemetry.breadcrumb(
                    "Automations rules refresh after run failed, keeping cached rules — \(error.localizedDescription)",
                    category: "automations"
                )
            }
        } catch {
            actionError = error.localizedDescription
        }
    }

    /// Preview which listings a rule would touch right now.
    func dryRun(_ rule: AutomationRule) async throws -> AutomationDryRunResult {
        try await service.dryRun(id: rule.id)
    }

    /// The recent actions a rule has applied.
    func activity(_ rule: AutomationRule) async throws -> [AutomationActionRow] {
        try await service.actions(id: rule.id)
    }
}
