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
            actions = (try? await service.actions()) ?? []
            phase = .ready
        } catch {
            phase = .failed(message: error.localizedDescription)
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
            actionError = error.localizedDescription
            return false
        }
    }

    func delete(_ rule: RepricingRule) async {
        rules.removeAll { $0.id == rule.id }
        do {
            try await service.delete(id: rule.id)
        } catch {
            actionError = error.localizedDescription
            await load()
        }
    }

    /// Flip a rule's enabled flag (full-replace PUT through the editor draft).
    func toggleEnabled(_ rule: RepricingRule) async {
        var draft = RuleDraft(from: rule)
        draft.enabled.toggle()
        await save(draft, editingId: rule.id)
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
            actions = (try? await service.actions()) ?? actions
            rules = (try? await service.list()) ?? rules
        } catch {
            actionError = error.localizedDescription
        }
    }
}
