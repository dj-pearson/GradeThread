import Foundation
import Observation

/// Loads + mutates the workspace's consignors (US-676). Mirrors the phase +
/// optimistic-action shape of ``TemplateStore``. Shared by the Settings manager,
/// the item canvas consignor picker, and the consignment report.
@MainActor
@Observable
final class ConsignorStore {
    enum Phase: Equatable {
        case loading
        case ready
        case failed(message: String)
    }

    private let service: ConsignorProviding

    var phase: Phase = .loading
    private(set) var consignors: [Consignor] = []
    /// Surfaced when a create/update/delete fails; the view shows it in an alert.
    var actionError: String?
    /// US-1026: reentrancy guard so pull-to-refresh can't kick off a duplicate
    /// concurrent fetch while the initial `.task` load (or another refresh) is
    /// still in flight. Private internal bookkeeping — no view observes it.
    private var isLoading = false

    init(service: ConsignorProviding = ConsignorService()) {
        self.service = service
    }

    var isEmpty: Bool { consignors.isEmpty }

    func consignor(id: String?) -> Consignor? {
        guard let id else { return nil }
        return consignors.first { $0.id == id }
    }

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        phase = .loading
        do {
            consignors = sorted(try await service.list())
            phase = .ready
        } catch {
            phase = .failed(message: error.localizedDescription)
        }
    }

    @discardableResult
    func save(_ draft: ConsignorDraft, editingId: String?) async -> Bool {
        do {
            let saved: Consignor
            if let editingId {
                saved = try await service.update(id: editingId, draft)
            } else {
                saved = try await service.create(draft)
            }
            upsert(saved)
            return true
        } catch {
            actionError = error.localizedDescription
            return false
        }
    }

    /// Optimistically removes, then deletes server-side; reloads on failure.
    func delete(_ consignor: Consignor) async {
        consignors.removeAll { $0.id == consignor.id }
        do {
            try await service.delete(id: consignor.id)
        } catch {
            actionError = error.localizedDescription
            await load()
        }
    }

    // MARK: - Private

    private func upsert(_ c: Consignor) {
        if let i = consignors.firstIndex(where: { $0.id == c.id }) {
            consignors[i] = c
        } else {
            consignors.append(c)
        }
        consignors = sorted(consignors)
    }

    private func sorted(_ list: [Consignor]) -> [Consignor] {
        list.sorted { $0.name.lowercased() < $1.name.lowercased() }
    }
}
