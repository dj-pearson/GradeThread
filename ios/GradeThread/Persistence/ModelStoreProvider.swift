import Foundation
import SwiftData

/// Builds the app's SwiftData `ModelContainer` with graceful recovery from a
/// corrupt on-disk store (US-987).
///
/// SwiftData throws from `ModelContainer(for:)` when the backing store can't be
/// opened — a schema/migration mismatch, file corruption, or a truncated write
/// under disk pressure. The previous launch path called `fatalError` here, which
/// crashed the app on *every* launch with no way to even sign out or clear data:
/// a permanent brick.
///
/// Instead this provider degrades in three steps:
///
///   1. **Normal load** — open the on-disk store as usual.
///   2. **Destructive recovery (one-time)** — if step 1 throws, delete the store
///      files and recreate an empty on-disk store. The cache is just a mirror of
///      Supabase, so a sync repopulates it; only unsynced pending mutations are
///      lost, which is strictly better than a relaunch loop.
///   3. **In-memory fallback** — if even step 2 throws (e.g. the directory is
///      unwritable), open an ephemeral in-memory container so the app still
///      launches. The caller surfaces a "local data was reset" notice; the user
///      can at least sign out, reconnect, or contact support.
///
/// A genuinely broken *schema* (a programmer error, not user data) is the only
/// case that still crashes — at step 3, where an in-memory container with the
/// same schema must succeed; if it can't, there is nothing to recover.
enum ModelStoreProvider {

    /// Result of building the container, so the UI can surface a one-time
    /// "local data was reset" notice when recovery had to discard the cache.
    struct LoadOutcome {
        let container: ModelContainer
        /// The on-disk store was corrupt and discarded (either replaced by a
        /// fresh empty on-disk store, or — worst case — an in-memory one).
        let didResetStore: Bool
        /// Even destructive recovery failed; we're on an ephemeral in-memory
        /// store that won't persist across launches.
        let isInMemoryFallback: Bool
    }

    /// Canonical schema for the offline cache. Single source of truth so the
    /// app launch path and recovery build the identical model graph. Derived
    /// from the current ``VersionedSchema`` (US-1143) so the schema and the
    /// migration plan can never drift apart.
    static var schema: Schema {
        Schema(versionedSchema: GradeThreadSchema.current)
    }

    /// Explicit on-disk store location. We name the store ourselves (rather than
    /// rely on SwiftData's implicit `default.store`) so destructive recovery can
    /// delete the exact files without guessing.
    static var defaultStoreURL: URL {
        URL.applicationSupportDirectory.appending(path: "GradeThread.store")
    }

    /// Builds the container, recovering from a corrupt store as described above.
    /// `storeURL` is injectable so tests can exercise recovery against a
    /// throwaway file.
    static func load(storeURL: URL = defaultStoreURL) -> LoadOutcome {
        // 1. Normal load — the overwhelmingly common path, untouched.
        if let container = try? makeOnDisk(at: storeURL) {
            return LoadOutcome(
                container: container,
                didResetStore: false,
                isInMemoryFallback: false
            )
        }

        // 2. One-time destructive recovery: delete the corrupt store + recreate.
        destroyStoreFiles(at: storeURL)
        if let container = try? makeOnDisk(at: storeURL) {
            return LoadOutcome(
                container: container,
                didResetStore: true,
                isInMemoryFallback: false
            )
        }

        // 3. In-memory fallback so the app still launches. An in-memory store
        //    with a valid schema can only fail if the schema itself is broken,
        //    so a throw here is a programmer error worth crashing on — there is
        //    no user data left to protect.
        do {
            let container = try makeInMemory()
            return LoadOutcome(
                container: container,
                didResetStore: true,
                isInMemoryFallback: true
            )
        } catch {
            fatalError("SwiftData schema is invalid; in-memory fallback failed: \(error)")
        }
    }

    // MARK: - Builders

    private static func makeOnDisk(at url: URL) throws -> ModelContainer {
        // Note: cloudKitDatabase is intentionally `.none` — sync goes through
        // Supabase, not iCloud. Keeping CloudKit off avoids surprise duplicate-
        // account merges across iCloud users on one device.
        let configuration = ModelConfiguration(
            schema: schema,
            url: url,
            cloudKitDatabase: .none
        )
        return try ModelContainer(
            for: schema,
            migrationPlan: GradeThreadMigrationPlan.self,
            configurations: configuration
        )
    }

    private static func makeInMemory() throws -> ModelContainer {
        let configuration = ModelConfiguration(
            schema: schema,
            isStoredInMemoryOnly: true,
            cloudKitDatabase: .none
        )
        return try ModelContainer(
            for: schema,
            migrationPlan: GradeThreadMigrationPlan.self,
            configurations: configuration
        )
    }

    /// Deletes the SQLite store plus its sidecar files. SwiftData (Core Data
    /// under the hood) keeps a write-ahead log (`-wal`) and shared-memory index
    /// (`-shm`) alongside the main store; leaving either behind can resurrect the
    /// corruption, so all three go. Best-effort — a missing file is fine.
    static func destroyStoreFiles(at url: URL) {
        let fileManager = FileManager.default
        let name = url.lastPathComponent
        let directory = url.deletingLastPathComponent()
        for suffix in ["", "-wal", "-shm"] {
            let target = directory.appending(path: name + suffix)
            try? fileManager.removeItem(at: target)
        }
    }
}
