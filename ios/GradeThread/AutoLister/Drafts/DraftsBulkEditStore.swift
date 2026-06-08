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
    }

    /// Final values to persist. Blank strings become NULL.
    func toEdit() -> DraftEdit {
        DraftEdit(
            id: id,
            title: Self.nilIfBlank(title),
            price: Double(price) ?? 0,
            condition: Self.nilIfBlank(condition),
            quantity: max(1, Int(quantity) ?? 1),
            bestOffer: bestOffer,
            categoryId: Self.nilIfBlank(categoryId),
            returnPolicyId: returnPolicyId,
            shippingPolicyId: shippingPolicyId,
            paymentPolicyId: paymentPolicyId
        )
    }

    /// Local publish-readiness heuristics (mirrors the web's rowIssues).
    var issues: [String] {
        var out: [String] = []
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { out.append("Title is empty") }
        else if title.count > 80 { out.append("Title over 80 chars") }
        if (Double(price) ?? 0) <= 0 { out.append("Price not set") }
        if condition.isEmpty { out.append("No condition") }
        if categoryId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { out.append("No category") }
        return out
    }

    static func nilIfBlank(_ s: String) -> String? {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    /// Clean editable string for a price (no trailing ".00", no exponent).
    static func priceString(_ value: Double?) -> String {
        guard let value else { return "" }
        if value == value.rounded() { return String(Int(value)) }
        return String(format: "%.2f", value)
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

    func update(_ id: String, _ mutate: (inout DraftEditRow) -> Void) {
        guard let i = rows.firstIndex(where: { $0.id == id }) else { return }
        mutate(&rows[i])
        rows[i].dirty = true
    }

    // MARK: - Bulk apply

    func applyMarkup(_ pctText: String) {
        guard let pct = Double(pctText.trimmingCharacters(in: .whitespaces)) else { return }
        applyToTargets { row in
            guard let base = Double(row.price) else { return }
            row.price = String(format: "%.2f", base * (1 + pct / 100))
        }
    }

    func applyRound99() {
        applyToTargets { row in
            guard let base = Double(row.price) else { return }
            row.price = String(format: "%.2f", Self.roundTo99(base))
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
            mutate(&rows[i])
            rows[i].dirty = true
        }
    }

    /// Mirrors the web's roundTo99: sub-$1 rounds to cents; otherwise floor + .99.
    nonisolated static func roundTo99(_ p: Double) -> Double {
        if p < 1 { return (p * 100).rounded() / 100 }
        return p.rounded(.down) + 0.99
    }

    // MARK: - Save

    func save() async {
        let dirty = rows.filter(\.dirty)
        guard !dirty.isEmpty else { return }
        isSaving = true
        defer { isSaving = false }
        var saved = 0
        for row in dirty {
            do {
                try await service.save(row.toEdit())
                saved += 1
            } catch {
                actionError = error.localizedDescription
                // Re-pull server truth (keeps the rows that did save).
                await load()
                return
            }
        }
        lastSavedCount = saved
        for i in rows.indices { rows[i].dirty = false }
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
        // Require saved edits so the server reflects the latest category/price.
        if targets.contains(where: \.dirty) {
            actionError = "Save your changes before publishing."
            return
        }
        isPublishing = true
        defer { isPublishing = false }

        var ok = 0
        var fails: [String] = []
        for row in targets {
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
                case .failed(let m):   fails.append("\(displayTitle(row)): \(m)")
                case .validated, .priceUpdated, .ended:
                    fails.append("\(displayTitle(row)): unexpected response")
                }
            case .validated(let r): fails.append("\(displayTitle(row)): \(r.blockers.joined(separator: ", "))")
            case .blockers(let b):  fails.append("\(displayTitle(row)): \(b.joined(separator: ", "))")
            case .noOfferId:        fails.append("\(displayTitle(row)): no eBay offer — sync first")
            case .failed(let m):    fails.append("\(displayTitle(row)): \(m)")
            case .pushed, .priceUpdated, .ended:
                fails.append("\(displayTitle(row)): unexpected response")
            }
        }

        publishSummary = fails.isEmpty
            ? "Published \(ok) draft\(ok == 1 ? "" : "s") to eBay."
            : "Published \(ok) of \(targets.count); \(fails.count) failed:\n" + fails.joined(separator: "\n")
        // Published items leave the drafts pool — refresh from server truth.
        if ok > 0 { await load() }
    }

    private func displayTitle(_ row: DraftEditRow) -> String {
        let t = row.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? titleFallback(for: row) : t
    }
}
