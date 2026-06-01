import Foundation
import Observation
import SwiftData

/// Drives the offline ↔ server reconciliation loop.
///
/// Two phases per pass:
///
/// 1. **Pull** — fetch fresh rows from `items_full` / `listings` / `sales`
///    via Supabase PostgREST and merge them into the SwiftData store using
///    ``ConflictPolicy``.
/// 2. **Flush** — drain `LocalPendingMutation` queue, applying each
///    mutation against the edge service. Failures bump `retryCount` and
///    stay queued; transient errors retry on the next pass.
///
/// The engine is an actor so its internal scheduling state never races,
/// even if the pull and flush triggers fire concurrently (foreground
/// notification + connectivity-restored at the same instant). UI-visible
/// status lives on ``SyncStatusStore`` which is `@MainActor`.
actor SyncEngine {
    private let container: ModelContainer
    private let statusStore: SyncStatusStore
    private let networkMonitor: NetworkMonitor

    /// Userspace tag for log prefixes so production logs are grep-able.
    private let logPrefix = "[SyncEngine]"

    /// Guard rail: a single active pull at a time avoids double-merging
    /// the same server response when, e.g., a foreground notification
    /// arrives mid-flush.
    private var isPulling = false
    private var isFlushing = false

    /// Background task watching connectivity. Started in `start()`,
    /// cancelled in `stop()`.
    private var connectivityTask: Task<Void, Never>?

    init(
        container: ModelContainer,
        statusStore: SyncStatusStore,
        networkMonitor: NetworkMonitor
    ) {
        self.container = container
        self.statusStore = statusStore
        self.networkMonitor = networkMonitor
    }

    // MARK: - Lifecycle

    func start() {
        guard connectivityTask == nil else { return }
        // Capture the @MainActor observables as locals so the Task closure
        // doesn't have to hop into the actor's isolation just to read them.
        let monitor = networkMonitor
        let status = statusStore
        connectivityTask = Task { [weak self] in
            let stream = await MainActor.run { monitor.connectivityStream() }
            for await connected in stream {
                if connected {
                    await status.set(.idle)
                    await self?.flushPending()
                    await self?.pull()
                } else {
                    await status.set(.offline)
                }
            }
        }
    }

    func stop() {
        connectivityTask?.cancel()
        connectivityTask = nil
    }

    /// Foreground entrypoint — also called when the user pulls-to-refresh.
    func sync() async {
        await pull()
        await flushPending()
        await refreshPendingCount()
    }

    // MARK: - Pull

    /// Fetches the current user's inventory_items + their primary photos
    /// from Supabase and merges into the local SwiftData cache via
    /// ``ConflictPolicy``. Pulled fields are the subset the inventory
    /// list (US-180) needs to render; listing + sale data joins land in
    /// US-184.
    func pull() async {
        guard !isPulling else { return }
        isPulling = true
        defer { isPulling = false }

        await statusStore.set(.syncing)

        let result = await pullRemote()
        switch result {
        case .success(let payload):
            await merge(payload: payload)
        case .failure(let error):
            // Don't propagate — connection errors are expected on the
            // road. The status banner will flip to .offline via the
            // NetworkMonitor stream when path-unsatisfied; for other
            // failures we just log and try again next pass.
            print("[SyncEngine] pull failed: \(error.localizedDescription)")
        }

        await refreshPendingCount()
        let pending = await pendingMutationCount()
        await statusStore.set(pending > 0 ? .pending : .idle)

        // US-190: republish the widget rollup off the freshly-merged
        // cache so the home-screen widget tracks the latest sync.
        await publishWidgetSnapshot()
    }

    /// Recomputes + writes the home-screen widget snapshot from the
    /// current local cache (US-190). Best-effort — a write failure (no
    /// App Group container) is silently ignored inside the publisher.
    private func publishWidgetSnapshot() async {
        let container = self.container
        await MainActor.run {
            WidgetSnapshotPublisher.publish(container: container, isSignedIn: true)
        }
    }

    // MARK: - Remote pull

    private struct PullPayload {
        let items: [RemoteInventoryItem]
        /// Every photo for every item in `items`, sorted by sort_order
        /// ascending. Merged into `LocalItemPhoto` so the item canvas
        /// can render the full strip; the inventory list's primary
        /// thumbnail derives from the first entry per item.
        let photos: [RemoteItemPhoto]

        /// Map of inventoryItemId → first photo (sort_order ascending).
        var primaryPhotos: [String: RemoteItemPhoto] {
            var out: [String: RemoteItemPhoto] = [:]
            for photo in photos where out[photo.inventory_item_id] == nil {
                out[photo.inventory_item_id] = photo
            }
            return out
        }
    }

    /// Wire-shape `inventory_items` row. Subset of columns the iOS app
    /// reads today — extend cautiously, every column is an extra byte
    /// per row over the wire. Non-private so US-198's RealtimeService can
    /// feed it back through `applyServerWins` when a postgres-change
    /// notification arrives.
    struct RemoteInventoryItem: Decodable {
        let id: String
        let user_id: String
        let title: String
        let brand: String?
        let sku: String?
        let size: String?
        let color: String?
        let material: String?
        let status: String
        let target_price: Double?
        let acquired_price: Double?
        let grade_value: Double?
        let grade_label: String?
        let certificate_url: String?
        let condition_notes: String?
        let measurements: [String: Double]?
        let created_at: String
        let updated_at: String

        private enum CodingKeys: String, CodingKey {
            case id, user_id, title, brand, sku, size, color, material, status
            case target_price, acquired_price, grade_value, grade_label
            case certificate_url, condition_notes, measurements, created_at, updated_at
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            user_id = try c.decode(String.self, forKey: .user_id)
            title = try c.decode(String.self, forKey: .title)
            brand = try c.decodeIfPresent(String.self, forKey: .brand)
            sku = try c.decodeIfPresent(String.self, forKey: .sku)
            size = try c.decodeIfPresent(String.self, forKey: .size)
            color = try c.decodeIfPresent(String.self, forKey: .color)
            material = try c.decodeIfPresent(String.self, forKey: .material)
            status = try c.decode(String.self, forKey: .status)
            target_price = try c.decodeIfPresent(Double.self, forKey: .target_price)
            acquired_price = try c.decodeIfPresent(Double.self, forKey: .acquired_price)
            grade_value = try c.decodeIfPresent(Double.self, forKey: .grade_value)
            grade_label = try c.decodeIfPresent(String.self, forKey: .grade_label)
            certificate_url = try c.decodeIfPresent(String.self, forKey: .certificate_url)
            condition_notes = try c.decodeIfPresent(String.self, forKey: .condition_notes)
            created_at = try c.decode(String.self, forKey: .created_at)
            updated_at = try c.decode(String.self, forKey: .updated_at)
            // `measurements` is a free-form jsonb column. Some rows store
            // values as strings ("20.5") instead of numbers, and a strict
            // [String: Double] decode throws on those. Because the whole
            // result array decodes in one shot, a SINGLE such row silently
            // blanked the ENTIRE inventory list on device. Decode leniently:
            // keep numbers and numeric strings, drop anything else, never throw.
            measurements = Self.decodeLenientMeasurements(from: c)
        }

        /// Non-throwing measurements decode. Returns nil when the key is
        /// absent/null or the value isn't an object; otherwise a map of only
        /// the numerically-coercible entries.
        private static func decodeLenientMeasurements(
            from c: KeyedDecodingContainer<CodingKeys>
        ) -> [String: Double]? {
            // `try?` flattens decodeIfPresent's optional, so absent/null/odd
            // shapes all funnel to nil here — never a throw.
            guard let raw = try? c.decodeIfPresent(
                [String: MeasurementScalar].self, forKey: .measurements
            ) else { return nil }
            var out: [String: Double] = [:]
            for (key, scalar) in raw {
                if let value = scalar.doubleValue { out[key] = value }
            }
            return out
        }
    }

    /// Tolerant scalar for the free-form `measurements` jsonb. Accepts a JSON
    /// number or a numeric string ("20.5"); treats anything else — nested
    /// object, array, bool, non-numeric string — as "no value" rather than
    /// throwing, so one odd row can't break the whole inventory decode.
    private enum MeasurementScalar: Decodable {
        case number(Double)
        case string(String)
        case other

        var doubleValue: Double? {
            switch self {
            case .number(let d): return d
            case .string(let s): return Double(s)
            case .other: return nil
            }
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let d = try? c.decode(Double.self) { self = .number(d); return }
            if let s = try? c.decode(String.self) { self = .string(s); return }
            self = .other
        }
    }

    struct RemoteItemPhoto: Decodable {
        let id: String
        let inventory_item_id: String
        let photo_type: String
        let photo_url: String
        let thumbnail_url: String?
        let storage_path: String?
        let sort_order: Int
        let bytes: Int?
        let created_at: String
    }

    private func pullRemote() async -> Result<PullPayload, Error> {
        do {
            // Decode the rows one-by-one (not as one `[RemoteInventoryItem]`)
            // so a single malformed row can't abort the whole decode and blank
            // the entire inventory list. `.value` is all-or-nothing; here we
            // grab the raw bytes and skip only the bad rows.
            let response = try await SupabaseShared.client
                .from("inventory_items")
                .select(Self.itemColumns)
                .order("updated_at", ascending: false)
                .execute()
            let items = Self.decodeItemsResiliently(response.data)

            // Without items we don't need the photo fetch — short circuit
            // so a brand-new account doesn't spend a round trip.
            guard !items.isEmpty else {
                return .success(PullPayload(items: [], photos: []))
            }
            let itemIds = items.map(\.id)
            let photoResponse = try await SupabaseShared.client
                .from("item_photos")
                .select(Self.photoColumns)
                .in("inventory_item_id", values: itemIds)
                .order("sort_order", ascending: true)
                .execute()
            let photos = Self.decodePhotosResiliently(photoResponse.data)
            return .success(PullPayload(items: items, photos: photos))
        } catch {
            return .failure(error)
        }
    }

    // Single-line, no embedded whitespace/newlines: PostgREST's `select`
    // parser does not trim column names, so a multi-line string sent column
    // names like "\n    brand" → 400 → the whole pull failed silently and
    // blanked the inventory list.
    private static let itemColumns =
        "id,user_id,title,brand,sku,size,color,material,status,target_price,acquired_price,grade_value,grade_label,certificate_url,condition_notes,measurements,created_at,updated_at"

    private static let photoColumns =
        "id,inventory_item_id,photo_type,photo_url,thumbnail_url,storage_path,sort_order,bytes,created_at"

    /// Wrapper that decodes to nil instead of throwing, so one malformed
    /// element can't abort decoding of the whole array.
    private struct Failable<T: Decodable>: Decodable {
        let value: T?
        init(from decoder: Decoder) throws {
            value = try? decoder.singleValueContainer().decode(T.self)
        }
    }

    /// Decode inventory rows resiliently — drop (and log) any that fail so a
    /// single bad row never blanks the whole list. PostgREST returns columns
    /// as snake_case verbatim (no key conversion), which matches
    /// `RemoteInventoryItem`'s CodingKeys, so a plain `JSONDecoder` is correct.
    static func decodeItemsResiliently(_ data: Data) -> [RemoteInventoryItem] {
        guard let rows = try? JSONDecoder().decode(
            [Failable<RemoteInventoryItem>].self, from: data
        ) else { return [] }
        let items = rows.compactMap(\.value)
        let dropped = rows.count - items.count
        if dropped > 0 {
            print("[SyncEngine] skipped \(dropped) undecodable inventory row(s)")
        }
        return items
    }

    /// Decode photo rows resiliently — same rationale as items. Previously the
    /// photos fetch used all-or-nothing `.value`, so a SINGLE row with (e.g.)
    /// a null `photo_url` threw and aborted the ENTIRE pull — blanking
    /// inventory as well as photos.
    static func decodePhotosResiliently(_ data: Data) -> [RemoteItemPhoto] {
        guard let rows = try? JSONDecoder().decode(
            [Failable<RemoteItemPhoto>].self, from: data
        ) else { return [] }
        return rows.compactMap(\.value)
    }

    private func merge(payload: PullPayload) async {
        let payload = payload  // capture for the @MainActor block below
        await MainActor.run {
            let context = ModelContext(self.container)
            let descriptor = FetchDescriptor<LocalInventoryItem>()
            let existing = (try? context.fetch(descriptor)) ?? []
            var existingById = Dictionary(uniqueKeysWithValues: existing.map { ($0.id, $0) })

            let isoFull = ISO8601DateFormatter()
            isoFull.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let isoPlain = ISO8601DateFormatter()
            func parseDate(_ s: String) -> Date {
                isoFull.date(from: s) ?? isoPlain.date(from: s) ?? .now
            }

            let primaryPhotos = payload.primaryPhotos
            for remote in payload.items {
                let createdAt = parseDate(remote.created_at)
                let updatedAt = parseDate(remote.updated_at)
                let primary = primaryPhotos[remote.id]
                let primaryURL = primary?.thumbnail_url ?? primary?.photo_url

                if let local = existingById[remote.id] {
                    self.applyServerWins(to: local, remote: remote)
                    local.primaryPhotoURL = primaryURL
                    // updatedAt is server-authoritative; createdAt never
                    // changes server-side so we don't reassign.
                    local.updatedAt = updatedAt
                } else {
                    let local = LocalInventoryItem(
                        id: remote.id,
                        userId: remote.user_id,
                        title: remote.title,
                        status: remote.status,
                        createdAt: createdAt,
                        updatedAt: updatedAt,
                        hasLocalChanges: false
                    )
                    self.applyServerWins(to: local, remote: remote)
                    local.primaryPhotoURL = primaryURL
                    context.insert(local)
                    existingById[remote.id] = local
                }
            }

            self.mergePhotos(payload.photos, context: context, parseDate: parseDate)
            try? context.save()
        }
    }

    /// Upserts every fetched item_photo into the local cache and prunes
    /// any local rows whose server-side photo disappeared. The list view
    /// uses primaryPhotoURL on LocalInventoryItem (cached above) while
    /// the canvas displays the full strip from this collection.
    private nonisolated func mergePhotos(
        _ remotePhotos: [RemoteItemPhoto],
        context: ModelContext,
        parseDate: (String) -> Date
    ) {
        let descriptor = FetchDescriptor<LocalItemPhoto>()
        let existing = (try? context.fetch(descriptor)) ?? []
        var existingById = Dictionary(uniqueKeysWithValues: existing.map { ($0.id, $0) })
        let remoteIds = Set(remotePhotos.map(\.id))

        for remote in remotePhotos {
            if let local = existingById[remote.id] {
                local.photoType = remote.photo_type
                local.photoURL = remote.photo_url
                local.thumbnailURL = remote.thumbnail_url
                local.storagePath = remote.storage_path
                local.sortOrder = remote.sort_order
                local.bytes = remote.bytes
            } else {
                let local = LocalItemPhoto(
                    id: remote.id,
                    inventoryItemId: remote.inventory_item_id,
                    photoType: remote.photo_type,
                    photoURL: remote.photo_url,
                    sortOrder: remote.sort_order,
                    createdAt: parseDate(remote.created_at)
                )
                local.thumbnailURL = remote.thumbnail_url
                local.storagePath = remote.storage_path
                local.bytes = remote.bytes
                context.insert(local)
                existingById[remote.id] = local
            }
        }

        // Drop locals whose server row has disappeared — keeps the strip
        // accurate after the user deletes a photo on the web.
        for stale in existing where !remoteIds.contains(stale.id) {
            context.delete(stale)
        }
    }

    /// Field-level merge that defers to ``ConflictPolicy`` for each
    /// column. User-owned fields (title/brand/notes/measurements/
    /// target_price) keep the local edit when hasLocalChanges is set;
    /// everything else takes the server value.
    private nonisolated func applyServerWins(
        to local: LocalInventoryItem,
        remote: RemoteInventoryItem
    ) {
        local.title = ConflictPolicy.resolveUserOwned(
            local: local.title,
            server: remote.title,
            hasLocalChanges: local.hasLocalChanges
        )
        local.brand = ConflictPolicy.resolveUserOwned(
            local: local.brand,
            server: remote.brand,
            hasLocalChanges: local.hasLocalChanges
        )
        local.sku = ConflictPolicy.resolveUserOwned(
            local: local.sku,
            server: remote.sku,
            hasLocalChanges: local.hasLocalChanges
        )
        local.size = ConflictPolicy.resolveUserOwned(
            local: local.size,
            server: remote.size,
            hasLocalChanges: local.hasLocalChanges
        )
        local.color = ConflictPolicy.resolveUserOwned(
            local: local.color,
            server: remote.color,
            hasLocalChanges: local.hasLocalChanges
        )
        local.material = ConflictPolicy.resolveUserOwned(
            local: local.material,
            server: remote.material,
            hasLocalChanges: local.hasLocalChanges
        )
        local.conditionNotes = ConflictPolicy.resolveUserOwned(
            local: local.conditionNotes,
            server: remote.condition_notes,
            hasLocalChanges: local.hasLocalChanges
        )
        local.targetPrice = ConflictPolicy.resolveUserOwned(
            local: local.targetPrice,
            server: remote.target_price,
            hasLocalChanges: local.hasLocalChanges
        )
        // measurements stored as JSON string on the local side; we
        // serialize the server payload before assigning so the column
        // round-trips cleanly.
        local.measurementsJSON = serializeMeasurements(remote.measurements, fallback: local.measurementsJSON)
        // Server-owned fields: always take the server value.
        local.acquiredPrice = remote.acquired_price
        local.gradeValue = remote.grade_value
        local.gradeLabel = remote.grade_label
        local.certificateURL = remote.certificate_url
        local.status = ConflictPolicy.resolveServerOwned(local: local.status, server: remote.status)
    }

    private nonisolated func serializeMeasurements(
        _ remote: [String: Double]?,
        fallback: String?
    ) -> String? {
        guard let remote, !remote.isEmpty else { return fallback }
        return (try? JSONSerialization.data(withJSONObject: remote))
            .flatMap { String(data: $0, encoding: .utf8) }
            ?? fallback
    }

    // MARK: - Realtime (US-198)

    /// Applies one Postgres-change row from the Realtime channel. The
    /// JSON shape Supabase ships in the record matches the polled fetch
    /// shape (`RemoteInventoryItem`), so we re-decode through a single
    /// path and reuse `applyServerWins` + the ConflictPolicy.
    public func applyRealtimeInventoryUpsert(record: Data) async {
        do {
            let decoder = JSONDecoder()
            let remote = try decoder.decode(RemoteInventoryItem.self, from: record)
            await mergeSingle(remote: remote)
        } catch {
            // Realtime payloads occasionally carry shapes we don't know
            // (new columns introduced server-side). Logging keeps the
            // signal but doesn't block subsequent rows.
            print("[Realtime] inventory upsert decode failed: \(error)")
        }
    }

    /// Applies a single inventory row, creating or updating as needed.
    /// Pulls existing photo URL from the cache so the cached
    /// primaryPhotoURL doesn't get clobbered by the upsert.
    private func mergeSingle(remote: RemoteInventoryItem) async {
        await MainActor.run {
            let context = ModelContext(self.container)
            let id = remote.id
            let descriptor = FetchDescriptor<LocalInventoryItem>(
                predicate: #Predicate { $0.id == id }
            )
            let existing = (try? context.fetch(descriptor).first)

            let isoFull = ISO8601DateFormatter()
            isoFull.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            func parseDate(_ s: String) -> Date {
                isoFull.date(from: s) ?? ISO8601DateFormatter().date(from: s) ?? .now
            }
            let createdAt = parseDate(remote.created_at)
            let updatedAt = parseDate(remote.updated_at)

            if let local = existing {
                self.applyServerWins(to: local, remote: remote)
                local.updatedAt = updatedAt
            } else {
                let local = LocalInventoryItem(
                    id: remote.id,
                    userId: remote.user_id,
                    title: remote.title,
                    status: remote.status,
                    createdAt: createdAt,
                    updatedAt: updatedAt,
                    hasLocalChanges: false
                )
                self.applyServerWins(to: local, remote: remote)
                context.insert(local)
            }
            try? context.save()
        }
    }

    /// Delete handler for Realtime DELETE events on inventory_items.
    /// We pass the row id rather than the full record because Supabase's
    /// delete payload only carries the primary-key columns.
    public func applyRealtimeInventoryDelete(id: String) async {
        await MainActor.run {
            let context = ModelContext(self.container)
            let descriptor = FetchDescriptor<LocalInventoryItem>(
                predicate: #Predicate { $0.id == id }
            )
            if let row = try? context.fetch(descriptor).first {
                context.delete(row)
                try? context.save()
            }
        }
    }

    // MARK: - Flush

    func flushPending() async {
        guard !isFlushing else { return }
        isFlushing = true
        defer { isFlushing = false }

        let mutations = await loadPendingMutations()
        guard !mutations.isEmpty else { return }

        await statusStore.set(.syncing)
        for mutation in mutations {
            await apply(mutation)
        }
        await refreshPendingCount()
    }

    /// Concrete mutation handlers will fan out from here per ``MutationKind``.
    /// For now, every mutation just no-ops and stays queued so the offline
    /// queue plumbing is observable end-to-end without depending on the
    /// (yet-to-wire) intake / photo-upload flows.
    private func apply(_ mutation: LocalPendingMutation) async {
        guard let kind = mutation.kindEnum else {
            await markFailed(mutation, error: "unknown mutation kind \(mutation.kind)")
            return
        }
        switch kind {
        case .createInventoryItem,
             .updateInventoryItem,
             .deleteInventoryItem,
             .uploadPhoto,
             .deletePhoto,
             .createListing,
             .createSale:
            // TODO(US-175 / US-178): wire the EdgeAPI / supabase calls per
            // kind. Until then we bump retryCount + lastError so the queue
            // doesn't silently lie about progress.
            await markFailed(
                mutation,
                error: "Mutation handler for \(kind.rawValue) lands in US-175 / US-178."
            )
        }
    }

    // MARK: - SwiftData helpers

    /// Snapshot the queue inside a `@MainActor` ModelContext. We don't pass
    /// PersistentModel instances across the actor boundary — only the
    /// scalar payloads they hold.
    private func loadPendingMutations() async -> [LocalPendingMutation] {
        await MainActor.run {
            let context = ModelContext(container)
            let descriptor = FetchDescriptor<LocalPendingMutation>(
                sortBy: [SortDescriptor(\.createdAt)]
            )
            return (try? context.fetch(descriptor)) ?? []
        }
    }

    private func markFailed(_ mutation: LocalPendingMutation, error: String) async {
        await MainActor.run {
            let context = ModelContext(container)
            let id = mutation.id
            let descriptor = FetchDescriptor<LocalPendingMutation>(
                predicate: #Predicate { $0.id == id }
            )
            guard let row = try? context.fetch(descriptor).first else { return }
            row.retryCount += 1
            row.lastError = error
            row.lastAttemptAt = .now
            try? context.save()
        }
    }

    private func pendingMutationCount() async -> Int {
        await MainActor.run {
            let context = ModelContext(container)
            let descriptor = FetchDescriptor<LocalPendingMutation>()
            return (try? context.fetchCount(descriptor)) ?? 0
        }
    }

    private func refreshPendingCount() async {
        let count = await pendingMutationCount()
        await statusStore.setPendingCount(count)
    }
}

// MARK: - Status store

/// Main-actor observable that backs ``SyncStatusBar``. Kept separate from
/// the actor-isolated engine so SwiftUI bindings don't have to hop actors
/// to read state.
@MainActor
@Observable
final class SyncStatusStore {
    enum Phase: Equatable {
        case idle
        case syncing
        case pending
        case offline
        /// US-198: Supabase Realtime channel is reconnecting after a
        /// network hiccup. Surfaces a chip so the user knows live
        /// updates are temporarily paused; switches back to .idle on
        /// re-subscribe.
        case reconnecting
    }

    var phase: Phase = .idle
    var pendingCount: Int = 0

    func set(_ next: Phase) {
        phase = next
    }

    func setPendingCount(_ count: Int) {
        pendingCount = count
        // Reconcile derived state: even if a pull just succeeded, surface
        // the pending banner instead of "idle" so the user knows writes
        // haven't shipped.
        if phase == .idle, count > 0 {
            phase = .pending
        } else if phase == .pending, count == 0 {
            phase = .idle
        }
    }
}
