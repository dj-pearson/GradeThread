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
    /// US-1166: true when the server fetch hit its row cap (500), so the view can
    /// tell the user they're seeing only the most recent drafts.
    private(set) var hitFetchCap = false
    /// US-964: selected draft (listing) ids for bulk-publish.
    var selected: Set<String> = []
    /// US-964: bulk-publish progress + the published-vs-skipped summary string
    /// (reuses the bulk-edit publish result UI shape).
    var isPublishing = false
    var publishSummary: String?
    /// US-820: bulk field-apply (price / condition / template) state.
    var isApplying = false
    var bulkProgress: BulkProgress?
    var bulkSummary: String?
    /// US-820 / US-805: set when a bulk publish hit a plan cap (402). The view
    /// surfaces the upgrade prompt + a paywall route instead of a generic error.
    var planLimitMessage: String?

    /// Per-item progress for a bulk field-apply run (so the UI can show "n/N").
    struct BulkProgress: Equatable { let done: Int; let total: Int }

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
            // fetchDrafts caps at 500 rows server-side; if we got exactly that,
            // there may be older drafts not shown (US-1166).
            hitFetchCap = all.count >= 500
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

    // MARK: - Bulk field apply (US-820)

    /// Applies one bulk field edit (price absolute/%/round, condition, or a
    /// template) to every SELECTED draft, persisting each through the drafts
    /// service one at a time. Per-draft failures are collected (no all-or-nothing
    /// silent failure): a single bad write doesn't sink the batch, and the
    /// summary names what didn't save. eBay-originated drafts are skipped (their
    /// fields are owned by eBay, US-1086). Reloads from server truth at the end
    /// so the rows reflect what actually persisted.
    func applyBulk(_ change: DraftBulkMutation.FieldChange) async {
        let targets = drafts.filter { selected.contains($0.id) }
        guard !targets.isEmpty else { return }
        isApplying = true
        bulkProgress = BulkProgress(done: 0, total: targets.count)
        defer { isApplying = false; bulkProgress = nil }

        var ok = 0
        var fails: [String] = []
        for (index, draft) in targets.enumerated() {
            defer { bulkProgress = BulkProgress(done: index + 1, total: targets.count) }
            var row = DraftEditRow(from: draft)
            if row.isEbayOriginated {
                fails.append("\(title(for: draft)): eBay-originated — edit on eBay")
                continue
            }
            DraftBulkMutation.apply(change, to: &row)
            do {
                try await service.save(row.toEdit())
                ok += 1
            } catch {
                fails.append("\(title(for: draft)): \(error.localizedDescription)")
            }
        }

        bulkSummary = fails.isEmpty
            ? "Updated \(ok) draft\(ok == 1 ? "" : "s")."
            : "Updated \(ok) of \(targets.count); \(fails.count) failed:\n" + fails.joined(separator: "\n")
        // Refresh from server truth so prices/conditions show what persisted; the
        // selection is preserved (load only prunes ids that no longer exist).
        await load()
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
        var planLimit: String?
        // Labeled so a plan-cap 402 stops the whole run — every remaining publish
        // would hit the same cap (US-820 / US-805).
        publishLoop: for draft in targets {
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
                case .planLimit(let m): planLimit = m; break publishLoop
                case .failed(let m):   fails.append("\(title(for: draft)): \(m)")
                case .validated, .priceUpdated, .ended:
                    fails.append("\(title(for: draft)): unexpected response")
                }
            case .validated(let r): fails.append("\(title(for: draft)): \(r.blockers.joined(separator: ", "))")
            case .blockers(let b):  fails.append("\(title(for: draft)): \(b.joined(separator: ", "))")
            case .noOfferId:        fails.append("\(title(for: draft)): no eBay offer — sync first")
            case .planLimit(let m): planLimit = m; break publishLoop
            case .failed(let m):    fails.append("\(title(for: draft)): \(m)")
            case .pushed, .priceUpdated, .ended:
                fails.append("\(title(for: draft)): unexpected response")
            }
        }

        if let planLimit {
            // Plan cap reached — route to the paywall via planLimitMessage instead
            // of a generic result alert. Note any that published before the cap.
            planLimitMessage = ok > 0
                ? "Published \(ok) before reaching your plan limit.\n\n\(planLimit)"
                : planLimit
        } else {
            publishSummary = fails.isEmpty
                ? "Published \(ok) draft\(ok == 1 ? "" : "s") to eBay."
                : "Published \(ok) of \(targets.count); \(fails.count) skipped:\n" + fails.joined(separator: "\n")
        }
        // Deselect what published; leave skipped drafts selected so the user can
        // retry after fixing them. Published drafts leave the pool — refresh from
        // server truth (which also prunes the now-stale selection via `load`).
        selected.subtract(published)
        if ok > 0 { await load() }
        return published
    }
}
