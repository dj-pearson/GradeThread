import Foundation
import Observation

/// Backs the AutoLister drafts library (US-675): loads every unpublished
/// AutoLister draft, with title fallback, search, and rollup totals. Mirrors
/// the web autolister-drafts surface.
@MainActor
@Observable
final class DraftsLibraryStore {
    enum Phase: Equatable {
        case loading
        case ready
        case failed(message: String)
    }

    private let service: DraftsProviding

    var phase: Phase = .loading
    /// AutoLister drafts only (batch_id != nil), newest first.
    private(set) var drafts: [DraftListing] = []
    private(set) var titles: [String: String] = [:]

    init(service: DraftsProviding = DraftsService()) {
        self.service = service
    }

    var isEmpty: Bool { drafts.isEmpty }

    /// Resolved title: listing title, else the parent item's, else a placeholder.
    func title(for d: DraftListing) -> String {
        if let t = d.listingTitle?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty {
            return t
        }
        if let t = titles[d.inventoryItemId], !t.isEmpty { return t }
        return "Untitled draft"
    }

    /// Drafts whose resolved title contains `query` (case-insensitive); all when blank.
    func filtered(matching query: String) -> [DraftListing] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return drafts }
        return drafts.filter { title(for: $0).lowercased().contains(q) }
    }

    var totalValue: Double { drafts.reduce(0) { $0 + ($1.listingPrice ?? 0) } }
    var batchCount: Int { Set(drafts.compactMap(\.batchId)).count }

    func load() async {
        phase = .loading
        do {
            let all = try await service.fetchDrafts()
            drafts = all.filter { $0.batchId != nil }
            titles = (try? await service.fetchItemTitles(ids: drafts.map(\.inventoryItemId))) ?? [:]
            phase = .ready
        } catch {
            phase = .failed(message: error.localizedDescription)
        }
    }
}
