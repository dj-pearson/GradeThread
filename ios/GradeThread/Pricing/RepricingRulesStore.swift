import Foundation
import Observation

/// Drives the repricing-automation surface (US-672): loads rules + the recent
/// applied-changes feed, CRUDs rules, toggles enablement, and triggers an
/// on-demand run. Mirrors the phase + optimistic-action shape of the other
/// FlipDesk stores.
@MainActor
@Observable
final class RepricingRulesStore {
    enum Phase: Equatable {
        case loading
        case ready
        case failed(message: String)
    }

    private let service: RepricingRulesProviding

    var phase: Phase = .loading
    private(set) var rules: [RepricingRule] = []
    private(set) var actions: [RepricingAction] = []
    var actionError: String?
    var banner: String?
    var isRunning = false

    init(service: RepricingRulesProviding = RepricingRulesService()) {
        self.service = service
    }

    var isEmpty: Bool { rules.isEmpty }
    var enabledCount: Int { rules.filter(\.enabled).count }

    func load() async {
        phase = .loading
        do {
            rules = try await service.list()
            actions = await loadActions(fallback: [])
            phase = .ready
        } catch {
            // US-1174: friendly copy instead of a raw service error.
            phase = .failed(message: FriendlyErrorCopy.actionMessage(for: error, fallback: "Couldn't load repricing rules. Please try again."))
        }
    }

    @discardableResult
    func save(_ draft: RuleDraft, editingId: String?) async -> Bool {
        do {
            let saved: RepricingRule
            if let editingId {
                saved = try await service.update(id: editingId, draft)
            } else {
                saved = try await service.create(draft)
            }
            if let i = rules.firstIndex(where: { $0.id == saved.id }) {
                rules[i] = saved
            } else {
                rules.append(saved)
            }
            return true
        } catch {
            actionError = FriendlyErrorCopy.actionMessage(for: error, fallback: "Couldn't save the rule. Please try again.")
            return false
        }
    }

    func delete(_ rule: RepricingRule) async {
        rules.removeAll { $0.id == rule.id }
        do {
            try await service.delete(id: rule.id)
        } catch {
            actionError = FriendlyErrorCopy.actionMessage(for: error, fallback: "Couldn't delete the rule. Please try again.")
            await load()
        }
    }

    /// Flip a rule's enabled flag (full-replace PUT through the editor draft).
    func toggleEnabled(_ rule: RepricingRule) async {
        // US-1198: flip optimistically so the switch moves immediately, then roll
        // back if the save fails (save sets actionError).
        guard let i = rules.firstIndex(where: { $0.id == rule.id }) else { return }
        let previous = rules[i].enabled
        rules[i].enabled.toggle()
        var draft = RuleDraft(from: rules[i])
        draft.enabled = rules[i].enabled
        let ok = await save(draft, editingId: rule.id)
        if !ok, let j = rules.firstIndex(where: { $0.id == rule.id }) {
            rules[j].enabled = previous
        }
    }

    /// Run the caller's rules immediately and refresh the feed.
    func runNow() async {
        isRunning = true
        defer { isRunning = false }
        do {
            let result = try await service.run()
            guard result.ok else {
                banner = "Repricing automation is currently turned off."
                return
            }
            banner = result.appliedCount > 0
                ? "Repriced \(result.appliedCount) listing\(result.appliedCount == 1 ? "" : "s")."
                : "No listings were due for a change."
            actions = await loadActions(fallback: actions)
            do {
                rules = try await service.list()
            } catch {
                // US-1003: the run succeeded; only the post-run rules refresh
                // failed. Keep the existing rules but breadcrumb so the stale
                // view is diagnosable rather than silently swallowed.
                Telemetry.breadcrumb(
                    "Repricing rules refresh after run failed, keeping cached rules — \(error.localizedDescription)",
                    category: "repricing"
                )
            }
        } catch {
            actionError = error.localizedDescription
        }
    }

    /// Load the applied-changes feed, falling back to `fallback` on failure.
    /// US-1003: the feed is non-critical, but a failed fetch is breadcrumbed so
    /// an empty/stale feed is diagnosable instead of silently swallowed.
    private func loadActions(fallback: [RepricingAction]) async -> [RepricingAction] {
        do {
            return try await service.actions()
        } catch {
            Telemetry.breadcrumb(
                "Repricing actions feed fetch failed, keeping \(fallback.count) cached — \(error.localizedDescription)",
                category: "repricing"
            )
            return fallback
        }
    }
}
