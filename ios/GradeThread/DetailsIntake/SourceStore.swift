import Foundation
import Observation
import SwiftData
import Supabase

/// Owns the `sources` cache for the intake form. Views read the existing
/// `LocalSource` rows via `@Query`; this store backfills from Supabase on
/// open and writes new sources through both Supabase and the local cache.
@MainActor
@Observable
public final class SourceStore {
    public var isRefreshing: Bool = false
    public var lastError: Error?

    private let container: ModelContainer
    private let supabase: SupabaseClient

    public init(
        container: ModelContainer,
        supabase: SupabaseClient = SupabaseShared.client
    ) {
        self.container = container
        self.supabase = supabase
    }

    /// Pulls fresh sources for the signed-in user and upserts them into
    /// the SwiftData cache so the Picker UI stays in sync across devices.
    public func refresh(userId: String) async {
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let rows: [RemoteSource] = try await supabase
                .from("sources")
                .select("id, user_id, name, source_type, notes, archived_at, created_at, updated_at")
                .eq("user_id", value: userId)
                .order("name", ascending: true)
                .execute()
                .value
            mergeIntoCache(rows)
            lastError = nil
        } catch {
            lastError = error
        }
    }

    /// Creates a new source via Supabase and writes it to the local
    /// cache. Returns the new row id so the picker can auto-select it.
    public func addSource(
        userId: String,
        name: String,
        type: FlipdeskSourceType,
        notes: String?
    ) async throws -> String {
        struct Insert: Encodable {
            let user_id: String
            let name: String
            let source_type: String
            let notes: String?
        }
        let payload = Insert(
            user_id: userId,
            name: name,
            source_type: type.rawValue,
            notes: notes
        )
        let rows: [RemoteSource] = try await supabase
            .from("sources")
            .insert(payload, returning: .representation)
            .select("id, user_id, name, source_type, notes, created_at, updated_at")
            .execute()
            .value
        guard let row = rows.first else {
            throw NSError(
                domain: "SourceStore", code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Insert returned no rows"]
            )
        }
        mergeIntoCache([row])
        return row.id
    }

    /// Updates an existing source's editable fields. Scoped to the signed-in
    /// user (the RLS-enforced user JWT client) AND filtered by `user_id` so a
    /// stray id can never touch another tenant's row.
    public func updateSource(
        id: String,
        userId: String,
        name: String,
        type: FlipdeskSourceType,
        notes: String?
    ) async throws {
        // Custom `encode` so a nil `notes` serializes as JSON `null` (clearing
        // the column) rather than being omitted — the synthesized Encodable for
        // an optional uses `encodeIfPresent`, which would skip it and silently
        // keep the old value on the server.
        struct Update: Encodable {
            let name: String
            let source_type: String
            let notes: String?
            enum CodingKeys: String, CodingKey { case name, source_type, notes }
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(name, forKey: .name)
                try c.encode(source_type, forKey: .source_type)
                if let notes { try c.encode(notes, forKey: .notes) }
                else { try c.encodeNil(forKey: .notes) }
            }
        }
        let payload = Update(name: name, source_type: type.rawValue, notes: notes)
        let rows: [RemoteSource] = try await supabase
            .from("sources")
            .update(payload, returning: .representation)
            .eq("id", value: id)
            .eq("user_id", value: userId)
            .select("id, user_id, name, source_type, notes, archived_at, created_at, updated_at")
            .execute()
            .value
        mergeIntoCache(rows)
    }

    /// Archives or restores a source. Archiving preserves every historical
    /// `inventory_items.source_id` link (unlike delete, which SET-NULLs them);
    /// it only hides the source from the intake pickers. Scoped to the user.
    public func setArchived(
        id: String,
        userId: String,
        archived: Bool
    ) async throws {
        // Explicit-null encode so a restore (nil stamp) writes `archived_at:
        // null` instead of omitting the field (which would no-op the update).
        struct ArchiveUpdate: Encodable {
            let archived_at: String?
            enum CodingKeys: String, CodingKey { case archived_at }
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                if let archived_at { try c.encode(archived_at, forKey: .archived_at) }
                else { try c.encodeNil(forKey: .archived_at) }
            }
        }
        let stamp = archived ? ISO8601DateFormatter().string(from: .now) : nil
        let rows: [RemoteSource] = try await supabase
            .from("sources")
            .update(ArchiveUpdate(archived_at: stamp), returning: .representation)
            .eq("id", value: id)
            .eq("user_id", value: userId)
            .select("id, user_id, name, source_type, notes, archived_at, created_at, updated_at")
            .execute()
            .value
        mergeIntoCache(rows)
    }

    // MARK: - Private

    private func mergeIntoCache(_ rows: [RemoteSource]) {
        let context = ModelContext(container)
        let descriptor = FetchDescriptor<LocalSource>()
        let existing = (try? context.fetch(descriptor)) ?? []
        var existingById = Dictionary(uniqueKeysWithValues: existing.map { ($0.id, $0) })

        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        for row in rows {
            let createdAt = isoFormatter.date(from: row.created_at)
                ?? ISO8601DateFormatter().date(from: row.created_at)
                ?? .now
            let updatedAt = isoFormatter.date(from: row.updated_at)
                ?? ISO8601DateFormatter().date(from: row.updated_at)
                ?? .now
            let archivedAt = row.archived_at.flatMap { raw in
                isoFormatter.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
            }
            if let local = existingById[row.id] {
                local.name = row.name
                local.sourceType = row.source_type
                local.notes = row.notes
                local.archivedAt = archivedAt
                local.updatedAt = updatedAt
            } else {
                let local = LocalSource(
                    id: row.id,
                    userId: row.user_id,
                    name: row.name,
                    sourceType: row.source_type,
                    archivedAt: archivedAt,
                    createdAt: createdAt,
                    updatedAt: updatedAt
                )
                local.notes = row.notes
                context.insert(local)
                existingById[row.id] = local
            }
        }
        try? context.save()
    }

    /// Wire-shape `sources` row. Matches the columns we select above.
    private struct RemoteSource: Decodable {
        let id: String
        let user_id: String
        let name: String
        let source_type: String
        let notes: String?
        let archived_at: String?
        let created_at: String
        let updated_at: String
    }
}
