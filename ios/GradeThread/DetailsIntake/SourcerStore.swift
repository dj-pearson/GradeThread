import Foundation
import Observation
import SwiftData
import Supabase

/// Owns the `sourcers` cache behind the "Sourced by" picker (US-2886).
///
/// Same shape as ``SourceStore``: views read the cached `LocalSourcer` rows via
/// `@Query`, this backfills from Supabase on open and writes new people through
/// both Supabase and the cache.
///
/// The one difference worth knowing: ``addSourcer`` returns a NAME rather than
/// an id, because a name is what `inventory_items.sourced_by` stores.
@MainActor
@Observable
public final class SourcerStore {
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

    /// Pulls the workspace's roster and upserts it into the SwiftData cache, so
    /// a teammate added on the web shows up in the picker on the phone.
    public func refresh(userId: String) async {
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let rows: [RemoteSourcer] = try await supabase
                .from("sourcers")
                .select("id, user_id, name, member_user_id, archived_at, created_at, updated_at")
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

    /// Adds a person to the roster and returns the name that should now be
    /// selected.
    ///
    /// A duplicate is NOT an error. The unique index on `(user_id, lower(name))`
    /// is the whole point of the roster, so a name that is already there comes
    /// back as whatever spelling is on the roster and the caller selects that
    /// instead of being shown a failure for a no-op.
    public func addSourcer(userId: String, name: String) async throws -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw NSError(
                domain: "SourcerStore", code: -2,
                userInfo: [NSLocalizedDescriptionKey: "Enter a name."]
            )
        }

        struct Insert: Encodable {
            let user_id: String
            let name: String
        }

        do {
            let rows: [RemoteSourcer] = try await supabase
                .from("sourcers")
                .insert(Insert(user_id: userId, name: trimmed), returning: .representation)
                .select("id, user_id, name, member_user_id, archived_at, created_at, updated_at")
                .execute()
                .value
            guard let row = rows.first else {
                throw NSError(
                    domain: "SourcerStore", code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "Insert returned no rows"]
                )
            }
            mergeIntoCache([row])
            return row.name
        } catch {
            if let existing = try await findByName(userId: userId, name: trimmed) {
                mergeIntoCache([existing])
                return existing.name
            }
            throw error
        }
    }

    // MARK: - Private

    /// Case-insensitive lookup, matching the unique index the insert collided
    /// with.
    ///
    /// The comparison is done in Swift rather than with a PostgREST `ilike`
    /// because a roster is a handful of rows and this keeps the query identical
    /// to the one `refresh` already makes.
    private func findByName(userId: String, name: String) async throws -> RemoteSourcer? {
        let rows: [RemoteSourcer] = try await supabase
            .from("sourcers")
            .select("id, user_id, name, member_user_id, archived_at, created_at, updated_at")
            .eq("user_id", value: userId)
            .execute()
            .value
        let wanted = name.lowercased()
        return rows.first { $0.name.lowercased() == wanted }
    }

    private func mergeIntoCache(_ rows: [RemoteSourcer]) {
        let context = ModelContext(container)
        let descriptor = FetchDescriptor<LocalSourcer>()
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
                local.memberUserId = row.member_user_id
                local.archivedAt = archivedAt
                local.updatedAt = updatedAt
            } else {
                let local = LocalSourcer(
                    id: row.id,
                    userId: row.user_id,
                    name: row.name,
                    memberUserId: row.member_user_id,
                    archivedAt: archivedAt,
                    createdAt: createdAt,
                    updatedAt: updatedAt
                )
                context.insert(local)
                existingById[row.id] = local
            }
        }
        context.saveOrLog("SourcerStore.mergeIntoCache")
    }

    /// Wire-shape `sourcers` row. Matches the columns selected above.
    private struct RemoteSourcer: Decodable {
        let id: String
        let user_id: String
        let name: String
        let member_user_id: String?
        let archived_at: String?
        let created_at: String
        let updated_at: String
    }
}
