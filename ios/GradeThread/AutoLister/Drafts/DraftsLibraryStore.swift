import Foundation
import Observation

/// The publish operations the drafts library needs to bulk-publish (US-964),
/// behind a protocol so the multi-publish loop is unit-testable with a fake —
/// ``EbayPublishService`` is a concrete `final class` wrapping live HTTP.
@MainActor
protocol DraftPublishing {
    func validate(inventoryItemId: String) async -> PublishOutcome
    func push(inventoryItemId: String, relist: Bool) async -> PublishOutcome
}

extension EbayPublishService: DraftPublishing {}

/// Backs the AutoLister drafts library (US-675): loads every unpublished
/// AutoLister draft, with title fallback, search, and rollup totals. Mirrors
/// the web autolister-drafts surface. US-964 adds multi-select + bulk-publish
/// straight from the library, so a batch can be finished without opening each
/// draft.
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
    /// US-964: selected draft (listing) ids for bulk-publish.
    var selected: Set<String> = []
    /// US-964: bulk-publish progress + the published-vs-skipped summary string
    /// (reuses the bulk-edit publish result UI shape).
    var isPublishing = false
    var publishSummary: String?

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
            // Drop selections for drafts that no longer exist (e.g. just published).
            let ids = Set(drafts.map(\.id))
            selected = selected.intersection(ids)
            phase = .ready
        } catch {
            phase = .failed(message: error.localizedDescription)
        }
    }

    // MARK: - Selection (US-964)

    func toggle(_ id: String) {
        if selected.contains(id) { selected.remove(id) } else { selected.insert(id) }
    }

    // MARK: - Bulk publish (US-964)

    /// Validates + pushes each SELECTED draft to eBay, one at a time, so a single
    /// blocker/failure doesn't sink the batch. Per-draft local issues (notably
    /// "No category") gate publish before any network call — the AutoLister flow's
    /// whole point is reaching live listings. eBay-originated rows are skipped
    /// (they're edited on eBay, US-1086). Returns the listing ids that published
    /// so the view can update the LocalListing cache optimistically.
    @discardableResult
    func publishSelected(using publisher: DraftPublishing? = nil) async -> Set<String> {
        // Default is nil (not `EbayPublishService()`): a default argument is
        // evaluated in the caller's nonisolated context, but EbayPublishService's
        // init is @MainActor — construct it inside this @MainActor method body
        // instead (same pattern as DraftsBulkEditStore.publishSelected).
        let publish = publisher ?? EbayPublishService()
        let targets = drafts.filter { selected.contains($0.id) }
        guard !targets.isEmpty else { return [] }
        isPublishing = true
        defer { isPublishing = false }

        var published: Set<String> = []
        var ok = 0
        var fails: [String] = []
        for draft in targets {
            let row = DraftEditRow(from: draft)
            if row.isEbayOriginated {
                fails.append("\(title(for: draft)): eBay-originated — edit on eBay")
                continue
            }
            if !row.issues.isEmpty {
                fails.append("\(title(for: draft)): \(row.issues.joined(separator: ", "))")
                continue
            }
            switch await publish.validate(inventoryItemId: draft.inventoryItemId) {
            case .validated(let r) where r.blockers.isEmpty:
                switch await publish.push(inventoryItemId: draft.inventoryItemId, relist: false) {
                case .pushed:
                    ok += 1
                    published.insert(draft.id)
                case .blockers(let b): fails.append("\(title(for: draft)): \(b.joined(separator: ", "))")
                case .noOfferId:       fails.append("\(title(for: draft)): no eBay offer — sync first")
                case .failed(let m):   fails.append("\(title(for: draft)): \(m)")
                case .validated, .priceUpdated, .ended:
                    fails.append("\(title(for: draft)): unexpected response")
                }
            case .validated(let r): fails.append("\(title(for: draft)): \(r.blockers.joined(separator: ", "))")
            case .blockers(let b):  fails.append("\(title(for: draft)): \(b.joined(separator: ", "))")
            case .noOfferId:        fails.append("\(title(for: draft)): no eBay offer — sync first")
            case .failed(let m):    fails.append("\(title(for: draft)): \(m)")
            case .pushed, .priceUpdated, .ended:
                fails.append("\(title(for: draft)): unexpected response")
            }
        }

        publishSummary = fails.isEmpty
            ? "Published \(ok) draft\(ok == 1 ? "" : "s") to eBay."
            : "Published \(ok) of \(targets.count); \(fails.count) skipped:\n" + fails.joined(separator: "\n")
        // Deselect what published; leave skipped drafts selected so the user can
        // retry after fixing them. Published drafts leave the pool — refresh from
        // server truth (which also prunes the now-stale selection via `load`).
        selected.subtract(published)
        if ok > 0 { await load() }
        return published
    }
}
