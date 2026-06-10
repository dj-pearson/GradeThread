import Foundation
import Supabase
import SwiftData

/// Persists photo reorder + delete from the item canvas. Uses the user's
/// Supabase client (anon key + session JWT), so RLS on `item_photos` scopes
/// every write to the caller's own rows — no service-role bypass here.
///
/// Server `sort_order` is the source of truth for the cover (lowest =
/// cover); we update only the rows that moved, then mirror the new order
/// into the local cache and recompute `item.primaryPhotoURL` so the grid
/// reflects the cover immediately (next sync recomputes it the same way).
@MainActor
struct PhotoEditService {
    private let supabase: SupabaseClient

    init(supabase: SupabaseClient = SupabaseShared.client) {
        self.supabase = supabase
    }

    private struct SortUpdate: Encodable { let sort_order: Int }

    /// Writes the new display order. `ordered` is the desired sequence
    /// (index = sort_order). Throws on the first server error; local state
    /// is left untouched in that case so the UI can show the failure and
    /// the next sync re-reconciles.
    func persistOrder(
        _ ordered: [LocalItemPhoto],
        item: LocalInventoryItem,
        context: ModelContext
    ) async throws {
        // Compute changes against the *current* sort_order before we mutate
        // anything locally.
        let changes = PhotoOrdering.changedSortOrders(ordered)
        for change in changes {
            try await supabase
                .from("item_photos")
                .update(SortUpdate(sort_order: change.sortOrder))
                .eq("id", value: change.id)
                .execute()
        }
        applyLocalOrder(ordered, item: item)
        try? context.save()
    }

    /// Deletes one photo, then closes the sort_order gap for the survivors.
    /// `remaining` is the post-deletion order (the caller has already
    /// removed `photo`).
    func delete(
        _ photo: LocalItemPhoto,
        remaining: [LocalItemPhoto],
        item: LocalInventoryItem,
        context: ModelContext
    ) async throws {
        let photoId = photo.id
        try await supabase
            .from("item_photos")
            .delete()
            .eq("id", value: photoId)
            .execute()

        // Re-densify survivors' sort_order on the server (computed before
        // local mutation), then delete the row + mirror locally.
        let changes = PhotoOrdering.changedSortOrders(remaining)
        for change in changes {
            try await supabase
                .from("item_photos")
                .update(SortUpdate(sort_order: change.sortOrder))
                .eq("id", value: change.id)
                .execute()
        }
        context.delete(photo)
        applyLocalOrder(remaining, item: item)
        try? context.save()
    }

    private struct TypeUpdate: Encodable { let photo_type: String }

    /// Changes a photo's `photo_type` (web "retag" parity). `serverType`
    /// must be one of `FlipdeskPhotoType.all`. Server first, then local
    /// mirror — on throw the local row is untouched.
    func retag(
        _ photo: LocalItemPhoto,
        to serverType: String,
        context: ModelContext
    ) async throws {
        try await supabase
            .from("item_photos")
            .update(TypeUpdate(photo_type: serverType))
            .eq("id", value: photo.id)
            .execute()
        photo.photoType = serverType
        try? context.save()
    }

    /// Mirrors the order into the local rows + refreshes the cached cover.
    private func applyLocalOrder(_ ordered: [LocalItemPhoto], item: LocalInventoryItem) {
        for (index, photo) in ordered.enumerated() {
            photo.sortOrder = index
        }
        let cover = ordered.first
        // primaryPhotoURL is a local cache only — the server recomputes it
        // from sort_order, so we don't write it back.
        item.primaryPhotoURL = cover?.thumbnailURL ?? cover?.photoURL
        item.updatedAt = .now
    }
}
