import Foundation
import Observation

/// One editable draft row in the bulk-edit grid (US-675). Seeded from a
/// ``DraftListing``; policy ids round-trip (shown only via "Apply template")
/// so saving never clobbers them. `dirty` gates which rows are persisted.
struct DraftEditRow: Identifiable, Equatable {
    let id: String
    let itemId: String
    var title: String
    var price: String
    var condition: String      // "" = none
    var quantity: String
    var bestOffer: Bool
    var categoryId: String
    var returnPolicyId: String?
    var shippingPolicyId: String?
    var paymentPolicyId: String?
    var priceIsEstimated: Bool
    var dirty: Bool = false
    /// Provenance from `DraftListing.listingOrigin` (US-1086). eBay-originated
    /// rows are read-only mirrors; their eBay-owned fields must not be saved.
    var listingOrigin: String?

    init(from d: DraftListing) {
        id = d.id
        itemId = d.inventoryItemId
        title = d.listingTitle ?? ""
        price = Self.priceString(d.listingPrice)
        condition = d.ebayCondition ?? ""
        quantity = d.quantity.map(String.init) ?? "1"
        bestOffer = d.bestOfferEnabled ?? false
        categoryId = d.platformCategoryId ?? ""
        returnPolicyId = d.returnPolicyId
        shippingPolicyId = d.shippingPolicyId
        paymentPolicyId = d.paymentPolicyId
        priceIsEstimated = d.priceIsEstimated ?? false
        listingOrigin = d.listingOrigin
    }

    /// True when this row's eBay-owned fields are locked because eBay is the
    /// source of truth (US-1086).
    var isEbayOriginated: Bool { listingOrigin == "ebay" }

    /// Final values to persist. Blank strings become NULL.
    func toEdit() -> DraftEdit {
        DraftEdit(
            id: id,
            title: Self.nilIfBlank(title),
            price: Self.parsePrice(price) ?? 0,
            condition: Self.nilIfBlank(condition),
            quantity: max(1, Int(quantity) ?? 1),
            bestOffer: bestOffer,
            categoryId: Self.nilIfBlank(categoryId),
            returnPolicyId: returnPolicyId,
            shippingPolicyId: shippingPolicyId,
            paymentPolicyId: paymentPolicyId,
            listingOrigin: listingOrigin
        )
    }

    /// Local publish-readiness heuristics (mirrors the web's rowIssues).
    var issues: [String] {
        var out: [String] = []
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { out.append("Title is empty") }
        else if title.count > 80 { out.append("Title over 80 chars") }
        if (Self.parsePrice(price) ?? 0) <= 0 { out.append("Price not set") }
        if condition.isEmpty { out.append("No condition") }
        if categoryId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { out.append("No category") }
        return out
    }

    static func nilIfBlank(_ s: String) -> String? {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    /// Clean editable string for a price in the user's locale decimal format, so
    /// it round-trips through ``parsePrice`` regardless of locale (US-1236).
    /// Whole numbers render with no decimals; fractional values render 2dp.
    static func priceString(_ value: Double?, locale: Locale = .current) -> String {
        guard let value else { return "" }
        if value == value.rounded() { return String(Int(value)) }
        return priceString2dp(value, locale: locale)
    }

    /// Locale-aware always-2-decimal price string (no grouping) — the grid's
    /// inline-field convention. Round-trips through ``parsePrice`` (US-1236):
    /// `String(format: "%.2f", …)` always emits a "." separator, which a
    /// comma-decimal locale would then misread, so format through the locale.
    static func priceString2dp(_ value: Double, locale: Locale = .current) -> String {
        let nf = NumberFormatter()
        nf.locale = locale
        nf.numberStyle = .decimal
        nf.minimumFractionDigits = 2
        nf.maximumFractionDigits = 2
        nf.usesGroupingSeparator = false
        return nf.string(from: NSNumber(value: value)) ?? String(format: "%.2f", value)
    }

    /// Locale-aware parse of an editable row's price string. The seeded canonical
    /// form (``priceString``) and a user-typed value both use the locale's
    /// decimal separator, so a single parser round-trips both — fixing the bug
    /// where a comma-decimal entry ("19,99") fell through `Double(_:)` to $0 and
    /// silently skipped the "Price not set" warning (US-1236).
    static func parsePrice(_ s: String, locale: Locale = .current) -> Double? {
        CurrencyFormatter(locale: locale).parse(s)
    }
}

/// Drives the AutoLister bulk-edit grid (US-675): loads a batch's (or all)
/// drafts into editable rows, supports multi-select + bulk-apply
/// (price markup / round-to-.99 / condition / category / template→policies),
/// and saves dirty rows. Mirrors the web autolister-bulk-edit surface.
@MainActor
@Observable
final class DraftsBulkEditStore {
    enum Phase: Equatable {
        case loading
        case ready
        case failed(message: String)
    }

    private let service: DraftsProviding
    /// nil = every AutoLister draft; otherwise scope to one batch.
    private let batchId: String?

    /// US-1243: how many dirty-row saves run concurrently in `save()`. Bounded
    /// so a large dirty batch doesn't open hundreds of sockets at once. Matches
    /// `DraftsLibraryStore.bulkSaveConcurrency` (US-1166).
    static let bulkSaveConcurrency = 4

    var phase: Phase = .loading
    var rows: [DraftEditRow] = []
    var selected: Set<String> = []
    private(set) var titles: [String: String] = [:]
    var isSaving = false
    var actionError: String?
    var lastSavedCount: Int?
    // US-681: bulk-publish drafts to eBay from the AutoLister surface.
    var isPublishing = false
    var publishSummary: String?

    init(service: DraftsProviding = DraftsService(), batchId: String? = nil) {
        self.service = service
        self.batchId = batchId
    }

    var dirtyCount: Int { rows.filter(\.dirty).count }
    var allSelected: Bool { !rows.isEmpty && selected.count == rows.count }
    /// Whether bulk actions target the selection or every row.
    var selectionSummary: String { selected.isEmpty ? "all rows" : "\(selected.count) selected" }
    private var targetIds: Set<String> { selected.isEmpty ? Set(rows.map(\.id)) : selected }

    func titleFallback(for row: DraftEditRow) -> String { titles[row.itemId] ?? "Title" }

    func load() async {
        phase = .loading
        do {
            var drafts = try await service.fetchDrafts().filter { $0.batchId != nil }
            if let batchId { drafts = drafts.filter { $0.batchId == batchId } }
            rows = drafts.map(DraftEditRow.init(from:))
            rebuildRowIndex() // US-1166: O(1) row lookups for the grid
            titles = (try? await service.fetchItemTitles(ids: drafts.map(\.inventoryItemId))) ?? [:]
            phase = .ready
        } catch {
            phase = .failed(message: error.localizedDescription)
        }
    }

    // MARK: - Selection

    func toggle(_ id: String) {
        if selected.contains(id) { selected.remove(id) } else { selected.insert(id) }
    }

    func toggleSelectAll() {
        selected = allSelected ? [] : Set(rows.map(\.id))
    }

    // MARK: - Per-row edit

    // US-1166: id→index map so the grid's per-field reads/writes are O(1)
    // instead of a `first(where:)` linear scan per field per render (O(n^2)).
    // Field edits never change row order/ids, so the map stays valid between
    // structural reloads; rebuild it only when `rows` is reassigned.
    private var indexById: [String: Int] = [:]

    private func rebuildRowIndex() {
        indexById = Dictionary(
            rows.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first }
        )
    }

    func row(id: String) -> DraftEditRow? {
        guard let i = indexById[id], rows.indices.contains(i) else { return nil }
        return rows[i]
    }

    func update(_ id: String, _ mutate: (inout DraftEditRow) -> Void) {
        guard let i = indexById[id], rows.indices.contains(i) else { return }
        // US-1242: eBay-originated rows are locked read-only mirrors (eBay owns
        // their fields). Never let an edit dirty one — `save()` would otherwise
        // silently clear its dirty flag as if it had persisted, hiding that the
        // edit was dropped. Keep them out of the dirty set up front instead.
        guard !rows[i].isEbayOriginated else { return }
        mutate(&rows[i])
        rows[i].dirty = true
    }

    // MARK: - Bulk apply

    func applyMarkup(_ pctText: String) {
        // US-1191: locale-aware parse so comma-decimal markups ("12,5") work.
        guard let pct = CurrencyFormatter().parse(pctText) else { return }
        applyPrice(.percent(pct))
    }

    /// US-820: set every target draft to one absolute price.
    func applyAbsolutePrice(_ priceText: String) {
        // US-1191: locale-aware parse so comma-decimal prices ("19,99") work.
        guard let price = CurrencyFormatter().parse(priceText) else { return }
        applyPrice(.absolute(price))
    }

    func applyRound99() {
        applyPrice(.round99)
    }

    /// Shared price-edit path: math via the pure ``DraftBulkMutation``, formatted
    /// in the grid's always-2dp convention so the inline field reads cleanly.
    private func applyPrice(_ change: DraftBulkMutation.PriceChange) {
        applyToTargets { row in
            // US-1236: read/write the row price locale-aware so a comma-decimal
            // current value isn't misread and the written value round-trips.
            guard let p = DraftBulkMutation.newPrice(for: DraftEditRow.parsePrice(row.price), change: change) else { return }
            row.price = DraftEditRow.priceString2dp(p)
        }
    }

    func applyCondition(_ condition: String) {
        applyToTargets { $0.condition = condition }
    }

    func applyCategory(_ categoryId: String) {
        let trimmed = categoryId.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        applyToTargets { $0.categoryId = trimmed }
    }

    /// US-674 integration: stamp a template's condition/category/policies onto
    /// the target rows — the bulk path for "policy" edits the grid can't show.
    func applyTemplate(_ t: ListingTemplate) {
        applyToTargets { row in
            if let c = t.ebayCondition, !c.isEmpty { row.condition = c }
            if let cat = t.ebayCategoryId, !cat.isEmpty { row.categoryId = cat }
            if let p = t.returnPolicyId { row.returnPolicyId = p }
            if let p = t.shippingPolicyId { row.shippingPolicyId = p }
            if let p = t.paymentPolicyId { row.paymentPolicyId = p }
        }
    }

    private func applyToTargets(_ mutate: (inout DraftEditRow) -> Void) {
        let ids = targetIds
        for i in rows.indices where ids.contains(rows[i].id) {
            // US-1242: skip eBay-originated read-only mirrors so a bulk edit never
            // dirties a row whose changes can't persist (eBay owns its fields).
            if rows[i].isEbayOriginated { continue }
            mutate(&rows[i])
            rows[i].dirty = true
        }
    }

    /// Mirrors the web's roundTo99: sub-$1 rounds to cents; otherwise floor + .99.
    /// Delegates to the shared pure helper (kept as a static for existing tests).
    nonisolated static func roundTo99(_ p: Double) -> Double {
        DraftBulkMutation.roundTo99(p)
    }

    // MARK: - Save

    func save() async {
        let dirty = rows.filter(\.dirty)
        guard !dirty.isEmpty else { return }
        isSaving = true
        defer { isSaving = false }

        // US-1191: track which rows actually persisted so a single failure keeps
        // the OTHER dirty rows' edits instead of reloading and wiping them all.
        var savedIds = Set<String>()
        // US-1243: build the per-row save work synchronously, then persist in
        // bounded-concurrency chunks (same pattern as DraftsLibraryStore.applyBulk)
        // so a large dirty batch isn't needlessly serial. Each save is an
        // independent row update with no shared state, so parallelism is safe.
        // US-1242: eBay-originated rows are excluded from the dirty set up front
        // now (see `update`/`applyToTargets`), so this is a defensive backstop:
        // if one is somehow dirty, clear it without a network call rather than
        // attempting a save that can't persist (eBay owns its fields).
        var work: [(id: String, label: String, edit: DraftEdit)] = []
        for row in dirty {
            if row.isEbayOriginated { savedIds.insert(row.id); continue }
            work.append((row.id, displayTitle(row), row.toEdit()))
        }

        var saved = 0
        // First failure by original row order → the single user-facing actionError;
        // mirrors the old serial loop, which surfaced the first failure and stopped.
        var firstFailure: (index: Int, message: String)?

        let service = self.service
        var baseIndex = 0
        chunkLoop: for chunk in work.chunked(into: Self.bulkSaveConcurrency) {
            let results = await withTaskGroup(
                of: (index: Int, id: String, message: String?).self
            ) { group -> [(index: Int, id: String, message: String?)] in
                for (offset, item) in chunk.enumerated() {
                    let index = baseIndex + offset
                    let id = item.id
                    let label = item.label
                    let edit = item.edit
                    group.addTask {
                        do {
                            try await service.save(edit)
                            return (index, id, nil)
                        } catch {
                            return (index, id, "Couldn't save \(label): \(error.localizedDescription). Your other edits are kept — fix and try again.")
                        }
                    }
                }
                var acc: [(index: Int, id: String, message: String?)] = []
                for await r in group { acc.append(r) }
                return acc
            }

            var chunkFailed = false
            for r in results {
                if let message = r.message {
                    chunkFailed = true
                    if r.index < (firstFailure?.index ?? Int.max) {
                        firstFailure = (r.index, message)
                    }
                } else {
                    saved += 1
                    savedIds.insert(r.id)
                }
            }
            baseIndex += chunk.count
            // Mirror the old break-on-first-failure: stop launching further chunks
            // once any save in this chunk failed, so the rest stay dirty for retry.
            if chunkFailed { break chunkLoop }
        }

        if let firstFailure { actionError = firstFailure.message }
        lastSavedCount = saved
        // Clear dirty only on rows that saved; the rest stay editable for retry.
        for i in rows.indices where savedIds.contains(rows[i].id) {
            rows[i].dirty = false
        }
    }

    // MARK: - Publish (US-681)

    /// Count of rows the publish action will target (selection, else all rows).
    var publishTargetCount: Int { rows.filter { targetIds.contains($0.id) }.count }

    /// Validates + pushes each targeted draft to eBay, one at a time, so a
    /// single blocker/failure doesn't sink the batch. Per-row local issues
    /// (notably "No category") gate publish before any network call — the
    /// AutoLister flow's whole point is reaching live listings (US-681).
    func publishSelected(service publish: EbayPublishService? = nil) async {
        // Default is nil (not `EbayPublishService()`): a default argument is
        // evaluated in the caller's nonisolated context, but EbayPublishService's
        // init is @MainActor — construct it inside this @MainActor method body
        // instead (same pattern as CompsStore / SnapStore / BulkGradeStore).
        let publish = publish ?? EbayPublishService()
        let targets = rows.filter { targetIds.contains($0.id) }
        guard !targets.isEmpty else { return }
        // US-1242: don't dead-end on "Save your changes before publishing" — that
        // generic block never said WHICH rows were unsaved. The user already
        // confirmed publish, so persist the unsaved targeted rows first
        // (save-then-publish), then name any that still couldn't be saved so they
        // know exactly what to fix instead of being silently stuck.
        if targets.contains(where: \.dirty) {
            await save()
            let stillDirty = rows.filter { targetIds.contains($0.id) && $0.dirty }
            if !stillDirty.isEmpty {
                let names = stillDirty.map(displayTitle).joined(separator: ", ")
                actionError = "Couldn't save these before publishing — fix and retry: \(names)."
                return
            }
        }
        isPublishing = true
        defer { isPublishing = false }

        var ok = 0
        var fails: [String] = []
        var planLimit: String?
        // Labeled so a plan-cap 402 can stop the whole run — every remaining
        // publish would hit the same cap (US-820 / US-805).
        publishLoop: for row in targets {
            if !row.issues.isEmpty {
                fails.append("\(displayTitle(row)): \(row.issues.joined(separator: ", "))")
                continue
            }
            switch await publish.validate(inventoryItemId: row.itemId) {
            case .validated(let r) where r.blockers.isEmpty:
                switch await publish.push(inventoryItemId: row.itemId) {
                case .pushed:          ok += 1
                case .blockers(let b): fails.append("\(displayTitle(row)): \(b.joined(separator: ", "))")
                case .noOfferId:       fails.append("\(displayTitle(row)): no eBay offer — sync first")
                case .planLimit(let m): planLimit = m; break publishLoop
                case .failed(let m):   fails.append("\(displayTitle(row)): \(m)")
                case .validated, .priceUpdated, .ended:
                    fails.append("\(displayTitle(row)): unexpected response")
                }
            case .validated(let r): fails.append("\(displayTitle(row)): \(r.blockers.joined(separator: ", "))")
            case .blockers(let b):  fails.append("\(displayTitle(row)): \(b.joined(separator: ", "))")
            case .noOfferId:        fails.append("\(displayTitle(row)): no eBay offer — sync first")
            case .planLimit(let m): planLimit = m; break publishLoop
            case .failed(let m):    fails.append("\(displayTitle(row)): \(m)")
            case .pushed, .priceUpdated, .ended:
                fails.append("\(displayTitle(row)): unexpected response")
            }
        }

        if let planLimit {
            // Plan cap reached — headline the upgrade prompt, noting any that
            // published before the cap was hit.
            publishSummary = ok > 0
                ? "Published \(ok) before reaching your plan limit.\n\n\(planLimit)"
                : planLimit
        } else {
            publishSummary = fails.isEmpty
                ? "Published \(ok) draft\(ok == 1 ? "" : "s") to eBay."
                : "Published \(ok) of \(targets.count); \(fails.count) failed:\n" + fails.joined(separator: "\n")
        }
        // Published items leave the drafts pool — refresh from server truth.
        if ok > 0 { await load() }
    }

    private func displayTitle(_ row: DraftEditRow) -> String {
        let t = row.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? titleFallback(for: row) : t
    }
}

// US-1243: split a collection into fixed-size chunks for bounded-concurrency
// saving. private so it can't collide with the sibling helper in
// DraftsLibraryStore.swift (each is file-scoped).
private extension Array {
    func chunked(into size: Int) -> [[Element]] {
        guard size > 0 else { return [self] }
        return stride(from: 0, to: count, by: size).map {
            Array(self[$0 ..< Swift.min($0 + size, count)])
        }
    }
}
