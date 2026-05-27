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
                .select("id, user_id, name, source_type, notes, created_at, updated_at")
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
            if let local = existingById[row.id] {
                local.name = row.name
                local.sourceType = row.source_type
                local.notes = row.notes
                local.updatedAt = updatedAt
            } else {
                let local = LocalSource(
                    id: row.id,
                    userId: row.user_id,
                    name: row.name,
                    sourceType: row.source_type,
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
        let created_at: String
        let updated_at: String
    }
}
