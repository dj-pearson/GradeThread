import Foundation
import Observation
import Supabase

/// US-816 — applies a suggested price to an item: writes `inventory_items
/// .target_price` (RLS-scoped, like ``QuickPriceSheet``) and, when a draft
/// listing exists, pushes the same price onto the draft via
/// ``ListingDraftService``. Abstracted so the store unit-tests with a fake.
@MainActor
protocol PriceSuggestionApplying {
    func apply(itemId: String, price: Double, updateDraft: Bool) async throws
}

@MainActor
struct PriceSuggestionService: PriceSuggestionApplying {
    private let supabase: SupabaseClient
    private let draftService: ListingDraftService

    init(supabase: SupabaseClient = SupabaseShared.client) {
        self.supabase = supabase
        self.draftService = ListingDraftService(supabase: supabase)
    }

    func apply(itemId: String, price: Double, updateDraft: Bool) async throws {
        struct PriceUpdate: Encodable { let target_price: Double }
        try await supabase
            .from("inventory_items")
            .update(PriceUpdate(target_price: price))
            .eq("id", value: itemId)
            .execute()
        if updateDraft {
            try await draftService.updateDraftPrice(inventoryItemId: itemId, price: price)
        }
    }
}

/// Drives ``PriceSuggestionsView``. Holds the candidate rows, serially fetches
/// eBay comps for each (rate-limit friendly, with progress), and applies /
/// dismisses per row. Comps use the server app token — no user eBay
/// connection required (same endpoints as the per-item canvas comps panel).
@MainActor
@Observable
final class PriceSuggestionsStore {
    enum Phase: Equatable {
        case idle
        /// Fetching comps; `done` of `total` rows resolved.
        case scanning(done: Int, total: Int)
        case ready
        /// Every row's comps fetch failed — surface a top-level retryable error
        /// instead of a list of identical buried per-row errors (US-1116).
        case failed(String)
    }

    enum RowState: Equatable {
        case pending     // comps not fetched yet
        case suggested   // has a comps-backed suggestion
        case noComps     // eBay returned nothing matchable
        case applied     // price written
        case dismissed   // hidden for this session
    }

    struct Row: Identifiable, Equatable {
        let candidate: PriceSuggestionCandidate
        var suggestion: PriceSuggestion?
        var state: RowState
        var id: String { candidate.id }
    }

    var phase: Phase = .idle
    private(set) var rows: [Row] = []
    var busy = false
    var actionError: String?
    var actionBanner: String?
    /// Per-row comps-fetch failures (soft — the scan keeps going).
    private(set) var rowErrors: [String: String] = [:]

    /// Rows still worth showing (applied/dismissed drop out of the list).
    var visibleRows: [Row] {
        rows.filter { $0.state != .dismissed && $0.state != .applied }
    }
    var appliedCount: Int { rows.filter { $0.state == .applied }.count }

    private let comps: CompsProviding
    private let applier: PriceSuggestionApplying
    /// Serial delay between comps calls so we don't hammer the edge / eBay.
    private let throttle: Duration
    /// Optional optimistic mirror into the SwiftData cache (set targetPrice on
    /// the local row so the list updates before the next sync). Nil in tests.
    private let mirror: (@MainActor (String, Double) -> Void)?

    init(
        comps: CompsProviding? = nil,
        applier: PriceSuggestionApplying? = nil,
        throttle: Duration = .milliseconds(400),
        mirror: (@MainActor (String, Double) -> Void)? = nil
    ) {
        self.comps = comps ?? CompsService()
        self.applier = applier ?? PriceSuggestionService()
        self.throttle = throttle
        self.mirror = mirror
    }

    /// Seeds the candidate rows and kicks off the comps scan exactly once.
    func start(candidates: [PriceSuggestionCandidate]) async {
        guard phase == .idle, rows.isEmpty else { return }
        rows = candidates.map { Row(candidate: $0, suggestion: nil, state: .pending) }
        await scan()
    }

    /// Serially resolves comps for every pending row, surfacing progress. A
    /// per-row failure soft-fails to `.noComps` (the row stays, un-applyable)
    /// so one bad title can't abort the whole batch.
    private func scan() async {
        let total = rows.count
        guard total > 0 else { phase = .ready; return }
        phase = .scanning(done: 0, total: total)

        var errorCount = 0
        var lastError: String?
        for index in rows.indices {
            if Task.isCancelled { break }
            let candidate = rows[index].candidate
            do {
                if let lookup = try await comps.lookup(
                    title: candidate.title, brand: candidate.brand, size: candidate.size
                ), let suggestion = PriceSuggestion.from(lookup: lookup) {
                    rows[index].suggestion = suggestion
                    rows[index].state = .suggested
                } else {
                    rows[index].state = .noComps
                }
            } catch {
                rows[index].state = .noComps
                let message = FriendlyErrorCopy.actionMessage(
                    for: error, fallback: "Couldn't load comps for this item."
                )
                rowErrors[candidate.id] = message
                errorCount += 1
                lastError = message
            }
            phase = .scanning(done: index + 1, total: total)
            if index + 1 < total, throttle > .zero {
                try? await Task.sleep(for: throttle)
            }
        }

        // A total wipeout (every row's comps fetch threw — e.g. offline) is a
        // top-level failure with retry, not N identical buried per-row errors.
        if errorCount == total, let lastError {
            phase = .failed(lastError)
        } else {
            phase = .ready
        }
    }

    /// Re-runs the comps scan from scratch (clears per-row errors + suggestions).
    /// Backs the top-level ``Phase/failed`` retry affordance.
    func retry() async {
        rowErrors = [:]
        for index in rows.indices {
            rows[index].state = .pending
            rows[index].suggestion = nil
        }
        await scan()
    }

    /// Optimistically marks the row applied and writes the suggested price.
    /// Reverts the row state on failure (revert-on-failure, AC2).
    func apply(_ row: Row) async {
        guard !busy,
              let suggestion = row.suggestion,
              let index = rows.firstIndex(where: { $0.id == row.id }) else { return }

        let previous = rows[index].state
        rows[index].state = .applied        // optimistic
        rowErrors[row.id] = nil
        actionError = nil
        busy = true
        defer { busy = false }

        do {
            try await applier.apply(
                itemId: row.id,
                price: suggestion.suggestedPrice,
                updateDraft: row.candidate.hasDraft
            )
            mirror?(row.id, suggestion.suggestedPrice)
            actionBanner = "Priced \(row.candidate.title)."
            HapticFeedback.success()
        } catch {
            rows[index].state = previous     // revert
            let message = FriendlyErrorCopy.actionMessage(
                for: error, fallback: "Couldn't apply that price. Try again."
            )
            rowErrors[row.id] = message
            actionError = message
            HapticFeedback.error()
        }
    }

    /// Hides a row for the rest of the session (no server write).
    func dismiss(_ row: Row) {
        guard let index = rows.firstIndex(where: { $0.id == row.id }) else { return }
        rows[index].state = .dismissed
        rowErrors[row.id] = nil
        HapticFeedback.light()
    }

    /// Per-row comps error, if any.
    func error(for row: Row) -> String? { rowErrors[row.id] }
}
