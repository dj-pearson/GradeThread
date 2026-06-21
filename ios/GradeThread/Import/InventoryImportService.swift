import Foundation
import Supabase

/// US-667 — commits mapped import drafts to `inventory_items` via supabase-swift,
/// the same write path the manual intake uses (so RLS + tenant scoping apply:
/// rows insert under the signed-in user). SKU-aware dedup mirrors the web
/// import: rows whose SKU already exists are skipped rather than duplicated.
@MainActor
final class InventoryImportService {

    private let supabase: SupabaseClient
    nonisolated init(supabase: SupabaseClient = SupabaseShared.client) {
        self.supabase = supabase
    }

    /// Aggregate outcome of a commit.
    struct Result: Equatable {
        var inserted = 0
        var skippedDuplicates = 0
        /// (1-based sheet row, message) per failed row.
        var errors: [(row: Int, message: String)] = []

        static func == (lhs: Result, rhs: Result) -> Bool {
            lhs.inserted == rhs.inserted
                && lhs.skippedDuplicates == rhs.skippedDuplicates
                && lhs.errors.map { $0.row } == rhs.errors.map { $0.row }
                && lhs.errors.map { $0.message } == rhs.errors.map { $0.message }
        }
    }

    /// Encodable subset of `inventory_items`. Nil fields are omitted by the
    /// encoder so DB defaults stand.
    private struct ItemInsert: Encodable {
        let user_id: String
        let title: String
        let sku: String?
        let brand: String?
        let style: String?
        let size: String?
        let color: String?
        let material: String?
        let item_category: String?
        let status: String
        let acquired_price: Double?
        let target_price: Double?
        let acquired_date: String?
        let description: String?
    }

    /// Inserts the ready drafts. `existingSkus` lets the caller pre-load the
    /// user's current SKUs for dedup; `progress` is called after each row.
    func commit(
        drafts: [(row: Int, draft: ImportItemDraft)],
        userId: String,
        progress: ((Int, Int) -> Void)? = nil
    ) async -> Result {
        var result = Result()
        var seenSkus = await loadExistingSkus(userId: userId, drafts: drafts)
        let total = drafts.count
        var done = 0

        // US-1166: Phase 1 (sequential, no network) — resolve the SKU dedup
        // (which is order-dependent for in-batch collisions) and build the
        // payloads to insert. Phase 2 then inserts them in bounded-concurrency
        // chunks instead of one round-trip at a time.
        var toInsert: [(row: Int, payload: ItemInsert)] = []
        for entry in drafts {
            let draft = entry.draft
            let sku = draft.sku?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
            if let sku, seenSkus.contains(sku) {
                result.skippedDuplicates += 1
                done += 1
                progress?(done, total)
                continue
            }
            if let sku { seenSkus.insert(sku) }
            toInsert.append((entry.row, ItemInsert(
                user_id: userId,
                title: draft.title,
                sku: sku,
                brand: draft.brand,
                style: draft.style,
                size: draft.size,
                color: draft.color,
                material: draft.material,
                item_category: draft.itemCategory,
                status: draft.status ?? "cataloged",
                acquired_price: draft.acquiredPrice,
                target_price: draft.targetPrice,
                acquired_date: draft.acquiredDate,
                description: draft.conditionNotes
            )))
        }

        // Phase 2: parallel inserts (independent rows, no shared state).
        let supabase = self.supabase
        for chunk in toInsert.chunked(into: Self.insertConcurrency) {
            let outcomes = await withTaskGroup(of: (row: Int, error: String?).self) { group -> [(row: Int, error: String?)] in
                for item in chunk {
                    let payload = item.payload
                    let row = item.row
                    group.addTask {
                        do {
                            try await supabase.from("inventory_items").insert(payload).execute()
                            return (row, nil)
                        } catch {
                            return (row, Self.friendly(error))
                        }
                    }
                }
                var acc: [(row: Int, error: String?)] = []
                for await o in group { acc.append(o) }
                return acc
            }
            // Fold results back in row order for a stable error list.
            for o in outcomes.sorted(by: { $0.row < $1.row }) {
                done += 1
                if let message = o.error {
                    result.errors.append((row: o.row, message: message))
                } else {
                    result.inserted += 1
                }
                progress?(done, total)
            }
        }
        return result
    }

    /// US-1166: how many import inserts run concurrently.
    static let insertConcurrency = 4

    /// Pre-loads the user's existing SKUs that appear in the import so dedup is
    /// a membership check rather than a per-row round-trip.
    private func loadExistingSkus(
        userId: String,
        drafts: [(row: Int, draft: ImportItemDraft)]
    ) async -> Set<String> {
        let importSkus = Set(drafts.compactMap {
            $0.draft.sku?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        })
        guard !importSkus.isEmpty else { return [] }
        struct Row: Decodable { let sku: String? }
        do {
            let rows: [Row] = try await supabase
                .from("inventory_items")
                .select("sku")
                .eq("user_id", value: userId)
                .in("sku", values: Array(importSkus))
                .execute()
                .value
            return Set(rows.compactMap { $0.sku })
        } catch {
            // Dedup is best-effort; on failure we just risk a 23505 the insert
            // path catches per-row.
            return []
        }
    }

    // US-1166: nonisolated + static so it can map errors from inside the
    // concurrent insert tasks (off the @MainActor service).
    nonisolated static func friendly(_ error: Error) -> String {
        let lower = error.localizedDescription.lowercased()
        if lower.contains("duplicate") || lower.contains("23505") {
            return "Duplicate SKU"
        }
        if lower.contains("invalid input value for enum") {
            return "Invalid category or status value"
        }
        return error.localizedDescription
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

// US-1166: bounded-concurrency chunking for the parallel insert phase.
private extension Array {
    func chunked(into size: Int) -> [[Element]] {
        guard size > 0 else { return [self] }
        return stride(from: 0, to: count, by: size).map {
            Array(self[$0 ..< Swift.min($0 + size, count)])
        }
    }
}
