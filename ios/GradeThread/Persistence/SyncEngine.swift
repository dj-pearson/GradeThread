import Foundation
import Observation
import Supabase
import SwiftData

/// Drives the offline ↔ server reconciliation loop.
///
/// Two phases per pass:
///
/// 1. **Pull** — fetch *changed* rows from `inventory_items` / `item_photos` /
///    `sales` via Supabase PostgREST (incremental, watermark-driven — US-633)
///    and merge them into the SwiftData store on a background ``SyncMergeActor``
///    (US-634) using ``ConflictPolicy``.
/// 2. **Flush** — drain the `LocalPendingMutation` queue, replaying each
///    mutation against Supabase / Storage (US-640). Confirmed writes are
///    dequeued; transient failures bump `retryCount` + keep `lastError` so the
///    pending-changes inspector (US-641) can surface and retry them.
///
/// The engine is an actor so its internal scheduling state never races, even if
/// pull and flush triggers fire concurrently. UI-visible status lives on
/// ``SyncStatusStore`` (`@MainActor`).
actor SyncEngine {
    private let container: ModelContainer
    private let statusStore: SyncStatusStore
    private let networkMonitor: NetworkMonitor

    /// Background ModelActor that owns the merge context off the main thread.
    private let mergeActor: SyncMergeActor
    /// Background ModelActor that owns the offline-mutation queue's SwiftData
    /// reads/writes off the main thread (US-1165) — snapshot/dequeue/failure/
    /// stuck bookkeeping + counts no longer hop to ``MainActor``.
    private let pendingActor: PendingMutationActor
    /// Per-table delta cursors (US-633).
    private let watermark = SyncWatermark()

    /// Page size for paginated server reads (US-633) — bounded so we never
    /// issue a single unbounded fetch of the whole catalog.
    private static let pageSize = 500
    /// Hard ceiling on rows pulled in one pass, a safety net against a runaway
    /// pagination loop.
    private static let maxRowsPerPass = 50_000
    /// Stop auto-retrying a mutation after this many failed attempts; it stays
    /// queued (with `lastError`) for the user to retry/discard via the
    /// inspector (US-641).
    private static let maxRetries = 6

    private var isPulling = false
    private var isFlushing = false
    /// US-1147: set by ``stop()`` so an in-flight flush stops dequeuing further
    /// mutations at a clean boundary (each replay is idempotent, so the one
    /// in-flight is safe to let finish or re-run next launch).
    private var isStopping = false
    private var connectivityTask: Task<Void, Never>?

    /// Debounces connectivity-driven syncs so a flap storm (walking between
    /// Wi-Fi/cell) coalesces into one flush+pull instead of one per flap
    /// (US-997). Manual ``sync()`` bypasses this and stays immediate.
    private var connectivityDebouncer: ConnectivityDebouncer?
    /// Window a burst of connectivity events must settle within before a single
    /// trailing sync fires.
    private static let connectivityDebounceWindow: Duration = .seconds(2)

    /// Last pull's error, if any — surfaced to pull-to-refresh (US-643) so the
    /// spinner can show a transient failure instead of silently succeeding.
    private var lastPullError: String?

    /// US-1221: when the last successful delete-reconciliation ran. In-memory
    /// (resets each launch), so reconciliation runs on the first pull of a
    /// session and at most once per ``reconcileInterval`` thereafter — frequent
    /// enough to clear server-side deletes promptly without an id-fetch every
    /// pass.
    private var lastReconcileAt: Date?
    private static let reconcileInterval: TimeInterval = 15 * 60

    /// Result of a foreground/refresh ``sync()``.
    enum SyncOutcome: Sendable {
        case ok
        case failed(String)
    }

    init(
        container: ModelContainer,
        statusStore: SyncStatusStore,
        networkMonitor: NetworkMonitor
    ) {
        self.container = container
        self.statusStore = statusStore
        self.networkMonitor = networkMonitor
        self.mergeActor = SyncMergeActor(modelContainer: container)
        self.pendingActor = PendingMutationActor(modelContainer: container)
    }

    // MARK: - Lifecycle

    func start() {
        isStopping = false
        guard connectivityTask == nil else { return }
        let monitor = networkMonitor
        let status = statusStore
        // One debounced flush+pull per connectivity burst (US-997).
        let debouncer = ConnectivityDebouncer(window: Self.connectivityDebounceWindow) { [weak self] in
            await self?.flushPending()
            await self?.pull()
        }
        connectivityDebouncer = debouncer
        connectivityTask = Task {
            let stream = await MainActor.run { monitor.connectivityStream() }
            for await connected in stream {
                if connected {
                    await status.set(.idle)
                    await debouncer.trigger()
                } else {
                    // Drop any pending sync — it would only fail offline.
                    await debouncer.cancel()
                    await status.set(.offline)
                }
            }
        }
    }

    func stop() {
        // US-1147: signal an in-flight flush to stop at the next mutation
        // boundary so sign-out / teardown can't leave the queue half-drained.
        isStopping = true
        connectivityTask?.cancel()
        connectivityTask = nil
        if let debouncer = connectivityDebouncer {
            Task { await debouncer.cancel() }
        }
        connectivityDebouncer = nil
    }

    /// Foreground entrypoint — also called when the user pulls-to-refresh.
    /// Returns the pull outcome so pull-to-refresh (US-643) can surface a
    /// transient failure; the result is discardable for fire-and-forget callers.
    @discardableResult
    func sync() async -> SyncOutcome {
        // US-1221: flush BEFORE pull, matching the connectivity path
        // (``start()``'s debouncer). A consistent flush-then-pull order across
        // both entrypoints pushes local intent up before server state merges
        // down, removing the nondeterministic resurrection/clobber window that
        // the old manual pull-then-flush ordering created.
        await flushPending()
        await pull()
        await refreshPendingCount()
        if let lastPullError { return .failed(lastPullError) }
        return .ok
    }

    /// Reset the delta cursors so the next pull is a full backfill. Called on
    /// sign-out (US-633) so the next account doesn't inherit this user's
    /// watermark.
    func resetWatermarks() {
        watermark.resetAll()
    }

    // MARK: - Pull (incremental)

    func pull() async {
        guard !isPulling else { return }
        isPulling = true
        defer { isPulling = false }

        await statusStore.set(.syncing)

        switch await pullRemote() {
        case .success(let payload):
            // Merge on the background actor (US-634) — never blocks the UI.
            await mergeActor.mergeItems(
                payload.items,
                primaryPhotos: payload.primaryPhotos,
                prune: payload.isFullItemSync
            )
            await mergeActor.mergePhotos(payload.photos, prune: payload.isFullPhotoSync)
            await mergeActor.mergeSales(payload.sales)
            await mergeActor.mergeExpenses(payload.expenses)
            await mergeActor.mergeListings(payload.listings)
            // US-819: stamp each item's dispute status from the changed disputes.
            // Runs after mergeItems so the items (and their grade_report_id) are
            // already present for the grade_report_id → item mapping.
            await mergeActor.mergeDisputes(payload.disputes)

            // Advance watermarks ONLY after a successful merge (US-633) so a
            // dropped pass re-fetches the missed rows next time. US-1210: each
            // cursor is the *drop-safe* value — it never advances past a row the
            // resilient decoder silently dropped, so an undecodable low-timestamp
            // row keeps the cursor behind it and is re-fetched (and re-decoded)
            // on the next delta pull instead of being lost below the watermark.
            watermark.advance(.inventoryItems, to: payload.itemCursor)
            watermark.advance(.itemPhotos, to: payload.photoCursor)
            watermark.advance(.sales, to: payload.saleCursor)
            watermark.advance(.expenses, to: payload.expenseCursor)
            watermark.advance(.disputes, to: payload.disputeCursor)
            watermark.advance(.listings, to: payload.listingCursor)
            lastPullError = nil

            // US-1221: prune rows deleted server-side (the watermark delta only
            // ever returns rows that still exist, so a delete never arrives that
            // way). Throttled + protects offline-created rows still pending push.
            await reconcileDeletesIfDue()
        case .failure(let error):
            // Connection errors are expected on the road; the banner flips to
            // .offline via NetworkMonitor. Log only in debug + record for the
            // pull-to-refresh failure surface (US-643).
            lastPullError = error.localizedDescription
            logError("pull failed: \(error.localizedDescription)")
        }

        await refreshPendingCount()
        let pending = await pendingMutationCount()
        await statusStore.set(pending > 0 ? .pending : .idle)

        // US-190 / US-637: republish the widget rollup — diffed + throttled so
        // an unchanged sync doesn't reload the timeline.
        await publishWidgetSnapshot()
    }

    /// Recomputes the widget snapshot off the main thread (``SyncMergeActor``)
    /// then publishes only when the numbers changed (US-637).
    private func publishWidgetSnapshot() async {
        let snapshot = await mergeActor.widgetSnapshot(isSignedIn: true)
        await MainActor.run {
            WidgetSnapshotPublisher.publishIfChanged(snapshot)
        }
    }

    // MARK: - Delete reconciliation (US-1221)

    /// Prunes local sales / expenses / listings / photos the server no longer
    /// has. The watermark-driven delta only returns rows that still exist, so a
    /// server-side delete (web, another device, a background job) never arrives
    /// that way — sales/expenses/listings had no prune at all and photos pruned
    /// only on a full backfill, so a deleted row lingered locally forever,
    /// inflating Money totals, dashboard rollups and the widget snapshot.
    ///
    /// Throttled to once per ``reconcileInterval`` (the id-only fetch is cheap
    /// but still a full scan). Skips entirely when every table's id fetch fails
    /// (offline) so the throttle isn't burned on a no-op.
    private func reconcileDeletesIfDue() async {
        let now = Date()
        if let last = lastReconcileAt, now.timeIntervalSince(last) < Self.reconcileInterval { return }

        let selfId = try? await SupabaseShared.client.auth.session.user.id.uuidString
        let ownerId = WorkspaceScope.activeOwnerId ?? selfId

        // Never prune a row whose server copy doesn't exist yet: offline creates
        // (the create is still queued) and staged photo uploads (the item_photos
        // row hasn't been inserted). Both materialize a local row optimistically.
        let protectedIds = Self.protectedReconcileIds(await snapshotMutations())

        // sales / expenses are user-scoped; listings + item_photos have no
        // user_id column (RLS scopes them via the parent item).
        let saleIds = await fetchServerIds(table: "sales", scopeUserId: ownerId)
        let expenseIds = await fetchServerIds(table: "flipdesk_expenses", scopeUserId: ownerId)
        let listingIds = await fetchServerIds(table: "listings", scopeUserId: nil)
        let photoIds = await fetchServerIds(table: "item_photos", scopeUserId: nil)

        // All fetches failed (offline) → don't touch the mirror or the throttle.
        guard saleIds != nil || expenseIds != nil || listingIds != nil || photoIds != nil else { return }

        await mergeActor.reconcileDeletes(
            saleIds: saleIds,
            expenseIds: expenseIds,
            listingIds: listingIds,
            photoIds: photoIds,
            protectedIds: protectedIds
        )
        lastReconcileAt = now
    }

    /// Fetches the surviving server `id` set for `table` (id column only, so the
    /// payload stays tiny even for thousands of rows), paginated + bounded by
    /// `maxRowsPerPass`. Returns nil on any error so the caller skips pruning
    /// that table rather than pruning against a partial view.
    private func fetchServerIds(table: String, scopeUserId: String?) async -> Set<String>? {
        var ids = Set<String>()
        var offset = 0
        do {
            while true {
                var query = SupabaseShared.client.from(table).select("id")
                if let scopeUserId { query = query.eq("user_id", value: scopeUserId) }
                let response = try await query
                    .order("id", ascending: true)
                    .range(from: offset, to: offset + Self.pageSize - 1)
                    .execute()
                let rows = (try? JSONSerialization.jsonObject(with: response.data)) as? [[String: Any]] ?? []
                for row in rows { if let id = row["id"] as? String { ids.insert(id) } }
                if rows.count < Self.pageSize { break }
                offset += Self.pageSize
                if offset >= Self.maxRowsPerPass { break }
            }
            return ids
        } catch {
            return nil
        }
    }

    /// Ids that delete-reconciliation must never prune because their server row
    /// legitimately doesn't exist yet (US-1221): every pending create's target
    /// id, plus the client-minted `photo_id` carried inside each queued photo
    /// upload (whose `targetId` is the parent item id, not the photo row id).
    static func protectedReconcileIds(_ queue: [PendingMutationSnapshot]) -> Set<String> {
        var ids = unconfirmedCreateTargetIds(queue)
        for mutation in queue where MutationKind(rawValue: mutation.kind) == .uploadPhoto {
            if let photoId = uploadPhotoId(from: mutation.payload) { ids.insert(photoId) }
        }
        return ids
    }

    private static func uploadPhotoId(from payload: Data) -> String? {
        guard let dict = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any] else { return nil }
        return dict["photo_id"] as? String
    }

    // MARK: - Remote pull

    private struct PullPayload {
        let items: [RemoteInventoryItem]
        let photos: [RemoteItemPhoto]
        let sales: [RemoteSaleRow]
        /// US-750: operating expenses, mirrored into the shared cache.
        let expenses: [RemoteExpenseRow]
        /// True when the photo pull was a full backfill (no watermark) — only
        /// then may the merge prune locals not present in the response.
        let isFullPhotoSync: Bool
        /// True when the ITEM pull was a full backfill (no watermark) — only
        /// then may the merge prune local items the server no longer returns
        /// (fixes stale "listed" rows that inflated the listed count). (00111)
        let isFullItemSync: Bool
        /// Changed listing rows (delta on `updated_at`, US-1221), mirrored into
        /// LocalListing so the item canvas can offer in-place revise (Sell offer
        /// present) or an Edit-on-eBay link. Each affected item's market price is
        /// derived from the cached LocalListing rows after the merge — no longer
        /// from a whole-table fetch every pass.
        let listings: [RemoteListing]
        /// US-819: changed dispute rows (delta), stamped onto their items'
        /// `disputeStatus` so the Grades list can badge them.
        let disputes: [RemoteDispute]

        // US-1210: per-table drop-safe watermark cursors. `nil` means "don't
        // advance" (every row in the page sorted at/after a dropped row, so
        // there is no safe value to move the cursor to without skipping it).
        let itemCursor: String?
        let photoCursor: String?
        let saleCursor: String?
        let expenseCursor: String?
        let disputeCursor: String?
        let listingCursor: String?

        /// Map of inventoryItemId → first photo (sort_order ascending). In
        /// delta mode this only covers items whose photos changed this pass.
        var primaryPhotos: [String: RemoteItemPhoto] {
            var out: [String: RemoteItemPhoto] = [:]
            for photo in photos.sorted(by: { $0.sort_order < $1.sort_order })
            where out[photo.inventory_item_id] == nil {
                out[photo.inventory_item_id] = photo
            }
            return out
        }
    }

    /// Wire-shape `inventory_items` row. Non-private so ``SyncMergeActor`` +
    /// ``RealtimeService`` can feed it through the same merge path.
    struct RemoteInventoryItem: Decodable, Sendable {
        let id: String
        let user_id: String
        let title: String
        let brand: String?
        let sku: String?
        let size: String?
        let color: String?
        let material: String?
        let status: String
        let item_category: String?
        let garment_type: String?
        let garment_category: String?
        let description: String?
        let style: String?
        let sourced_by: String?
        let acquired_date: String?
        let container: String?
        let comp_set: [ItemComp]?
        let source_id: String?
        let location_bin: String?
        let consignor_id: String?
        let consignment_split_pct: Double?
        let target_price: Double?
        let acquired_price: Double?
        let grade_value: Double?
        let grade_label: String?
        let certificate_url: String?
        /// US-819: linked grade report id, so the dispute sync can map a
        /// `disputes` row (keyed by grade_report_id) onto its item.
        let grade_report_id: String?
        let condition_notes: String?
        let measurements: [String: Double]?
        let created_at: String
        let updated_at: String

        private enum CodingKeys: String, CodingKey {
            case id, user_id, title, brand, sku, size, color, material, status
            case item_category
            case garment_type, garment_category
            case description, style, sourced_by
            case acquired_date, container, comp_set
            case source_id
            case location_bin, consignor_id, consignment_split_pct
            case target_price, acquired_price, grade_value, grade_label
            case certificate_url, grade_report_id
            case condition_notes, measurements, created_at, updated_at
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
            item_category = try c.decodeIfPresent(String.self, forKey: .item_category)
            garment_type = try c.decodeIfPresent(String.self, forKey: .garment_type)
            garment_category = try c.decodeIfPresent(String.self, forKey: .garment_category)
            description = try c.decodeIfPresent(String.self, forKey: .description)
            style = try c.decodeIfPresent(String.self, forKey: .style)
            sourced_by = try c.decodeIfPresent(String.self, forKey: .sourced_by)
            acquired_date = try c.decodeIfPresent(String.self, forKey: .acquired_date)
            container = try c.decodeIfPresent(String.self, forKey: .container)
            // Lenient: a single malformed comp must never blow up the row decode.
            comp_set = try? c.decodeIfPresent([ItemComp].self, forKey: .comp_set)
            source_id = try c.decodeIfPresent(String.self, forKey: .source_id)
            location_bin = try c.decodeIfPresent(String.self, forKey: .location_bin)
            consignor_id = try c.decodeIfPresent(String.self, forKey: .consignor_id)
            consignment_split_pct = try c.decodeIfPresent(Double.self, forKey: .consignment_split_pct)
            target_price = try c.decodeIfPresent(Double.self, forKey: .target_price)
            acquired_price = try c.decodeIfPresent(Double.self, forKey: .acquired_price)
            grade_value = try c.decodeIfPresent(Double.self, forKey: .grade_value)
            grade_label = try c.decodeIfPresent(String.self, forKey: .grade_label)
            certificate_url = try c.decodeIfPresent(String.self, forKey: .certificate_url)
            grade_report_id = try c.decodeIfPresent(String.self, forKey: .grade_report_id)
            condition_notes = try c.decodeIfPresent(String.self, forKey: .condition_notes)
            created_at = try c.decode(String.self, forKey: .created_at)
            updated_at = try c.decode(String.self, forKey: .updated_at)
            // Lenient measurements decode — one odd row must never blank the
            // whole inventory list.
            measurements = Self.decodeLenientMeasurements(from: c)
        }

        private static func decodeLenientMeasurements(
            from c: KeyedDecodingContainer<CodingKeys>
        ) -> [String: Double]? {
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

    /// Tolerant scalar for the free-form `measurements` jsonb.
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

    struct RemoteItemPhoto: Decodable, Sendable {
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

    /// Wire-shape `sales` row. Money fields decode leniently (numbers OR
    /// numeric strings).
    struct RemoteSaleRow: Decodable, Sendable {
        let id: String
        let inventory_item_id: String
        let sale_price: Double
        let platform_fees: Double
        let payment_processing_fees: Double
        let shipping_collected: Double
        let shipping_cost: Double
        let grading_cost: Double
        let other_costs: Double
        let tax: Double
        let net_profit: Double?
        let status: String
        let sale_date: String
        let buyer_username: String?
        let created_at: String

        private enum CodingKeys: String, CodingKey {
            case id, inventory_item_id, sale_price, platform_fees
            case payment_processing_fees, shipping_collected, shipping_cost
            case grading_cost, other_costs, tax, net_profit, status
            case sale_date, buyer_username, created_at
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            inventory_item_id = try c.decode(String.self, forKey: .inventory_item_id)
            sale_price = Self.lenientDouble(c, .sale_price) ?? 0
            platform_fees = Self.lenientDouble(c, .platform_fees) ?? 0
            payment_processing_fees = Self.lenientDouble(c, .payment_processing_fees) ?? 0
            shipping_collected = Self.lenientDouble(c, .shipping_collected) ?? 0
            shipping_cost = Self.lenientDouble(c, .shipping_cost) ?? 0
            grading_cost = Self.lenientDouble(c, .grading_cost) ?? 0
            other_costs = Self.lenientDouble(c, .other_costs) ?? 0
            tax = Self.lenientDouble(c, .tax) ?? 0
            net_profit = Self.lenientDouble(c, .net_profit)
            // Default 'completed' for legacy rows lacking the 00111 column.
            status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "completed"
            sale_date = try c.decode(String.self, forKey: .sale_date)
            buyer_username = try c.decodeIfPresent(String.self, forKey: .buyer_username)
            created_at = (try? c.decode(String.self, forKey: .created_at)) ?? ""
        }

        private static func lenientDouble(
            _ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys
        ) -> Double? {
            if let d = try? c.decodeIfPresent(Double.self, forKey: key) { return d }
            if let s = try? c.decodeIfPresent(String.self, forKey: key) { return Double(s) }
            return nil
        }
    }

    /// Wire-shape `flipdesk_expenses` row (US-750). `amount` is a Postgres
    /// decimal (number OR numeric string); `spent_on` is a date-only column.
    /// `inventory_item_id` / `listing_id` are the 00266 attribution links.
    struct RemoteExpenseRow: Decodable, Sendable {
        let id: String
        let category: String
        let description: String?
        let amount: Double
        let spent_on: String
        let inventory_item_id: String?
        let listing_id: String?
        let created_at: String

        private enum CodingKeys: String, CodingKey {
            case id, category, description, amount, spent_on
            case inventory_item_id, listing_id, created_at
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            category = (try? c.decode(String.self, forKey: .category)) ?? "other"
            description = try c.decodeIfPresent(String.self, forKey: .description)
            if let d = try? c.decode(Double.self, forKey: .amount) {
                amount = d
            } else if let s = try? c.decode(String.self, forKey: .amount), let d = Double(s) {
                amount = d
            } else {
                amount = 0
            }
            spent_on = (try? c.decode(String.self, forKey: .spent_on)) ?? ""
            inventory_item_id = try c.decodeIfPresent(String.self, forKey: .inventory_item_id)
            listing_id = try c.decodeIfPresent(String.self, forKey: .listing_id)
            created_at = (try? c.decode(String.self, forKey: .created_at)) ?? ""
        }

        /// Parsed `spent_on` — date-only first (what the column is), ISO fallback.
        var spentOnDate: Date {
            let dateOnly = DateFormatter()
            dateOnly.locale = Locale(identifier: "en_US_POSIX")
            dateOnly.timeZone = TimeZone(identifier: "UTC")
            dateOnly.dateFormat = "yyyy-MM-dd"
            if let d = dateOnly.date(from: spent_on) { return d }
            return SyncEngine.parseDate(spent_on)
        }
    }

    private func pullRemote() async -> Result<PullPayload, Error> {
        do {
            // US-670: scope the pull to the active workspace owner. Additive
            // workspace-member RLS (00042) returns the OWNER's rows to a member,
            // so without this filter a member's cache would mix every workspace
            // they belong to. Resolve once: the selected workspace, else self.
            let selfId = try? await SupabaseShared.client.auth.session.user.id.uuidString
            let ownerId = WorkspaceScope.activeOwnerId ?? selfId

            // Items — delta on updated_at, paginated (US-633).
            let itemWatermark = watermark.value(for: .inventoryItems)
            let isFullItemSync = (itemWatermark == nil)
            let itemsFetch = try await paginatedFetch(
                table: "inventory_items",
                columns: Self.itemColumns,
                cursor: SyncWatermark.Table.inventoryItems.cursorColumn,
                watermark: itemWatermark,
                scopeUserId: ownerId,
                decode: Self.decodeItemsResiliently,
                idOf: { $0.id }
            )
            let items = itemsFetch.rows

            // Photos + sales are BEST-EFFORT (a failure must not blank the
            // already-decoded inventory) and are themselves delta-scoped, so we
            // no longer short-circuit on an empty items delta — photos/sales can
            // change without an item change.
            let photoWatermark = watermark.value(for: .itemPhotos)
            let isFullPhotoSync = (photoWatermark == nil)
            let photosFetch = try? await paginatedFetch(
                table: "item_photos",
                columns: Self.photoColumns,
                cursor: SyncWatermark.Table.itemPhotos.cursorColumn,
                watermark: photoWatermark,
                decode: Self.decodePhotosResiliently,
                idOf: { $0.id }
            )
            let photos = photosFetch?.rows ?? []

            let salesFetch = try? await paginatedFetch(
                table: "sales",
                columns: Self.saleColumns,
                cursor: SyncWatermark.Table.sales.cursorColumn,
                watermark: watermark.value(for: .sales),
                scopeUserId: ownerId,
                decode: Self.decodeSalesResiliently,
                idOf: { $0.id }
            )
            let sales = salesFetch?.rows ?? []

            // US-750: operating expenses — best-effort + delta-scoped, mirrored
            // into the shared cache so the Money tab no longer needs a separate
            // server fetch (ExpenseStore.refresh).
            let expensesFetch = try? await paginatedFetch(
                table: "flipdesk_expenses",
                columns: Self.expenseColumns,
                cursor: SyncWatermark.Table.expenses.cursorColumn,
                watermark: watermark.value(for: .expenses),
                scopeUserId: ownerId,
                decode: Self.decodeExpensesResiliently,
                idOf: { $0.id }
            )
            let expenses = expensesFetch?.rows ?? []

            // US-1221: listings — best-effort + delta-scoped on `updated_at`
            // (the one table that used to be re-fetched in full every pass,
            // O(total listings)). The trigger bumps `updated_at` on every edit,
            // including eBay-driven price/status changes, so a delta still lands
            // those promptly. Each affected item's market price is derived from
            // the cached LocalListing rows in the merge, not from this fetch.
            // NOTE: no scopeUserId — `listings` has no user_id column; RLS
            // scopes it through the parent inventory_items row.
            let listingsFetch = try? await paginatedFetch(
                table: "listings",
                columns: Self.listingColumns,
                cursor: SyncWatermark.Table.listings.cursorColumn,
                watermark: watermark.value(for: .listings),
                decode: Self.decodeListingsResiliently,
                idOf: { $0.id }
            )
            let listingRows = listingsFetch?.rows ?? []

            // US-819: disputes — best-effort + delta-scoped on updated_at. A
            // dispute's `user_id` is the FILER (the signed-in user), not the
            // workspace owner — and RLS only returns `user_id = auth.uid()` rows
            // — so scope by `selfId`, NOT `ownerId`. One bounded query, NOT a
            // per-row fetch: the merge maps each row onto its item by
            // grade_report_id.
            let disputesFetch = try? await paginatedFetch(
                table: "disputes",
                columns: Self.disputeColumns,
                cursor: SyncWatermark.Table.disputes.cursorColumn,
                watermark: watermark.value(for: .disputes),
                scopeUserId: selfId,
                decode: Self.decodeDisputesResiliently,
                idOf: { $0.id }
            )
            let disputes = disputesFetch?.rows ?? []

            return .success(PullPayload(
                items: items, photos: photos, sales: sales,
                expenses: expenses,
                isFullPhotoSync: isFullPhotoSync,
                isFullItemSync: isFullItemSync,
                listings: listingRows,
                disputes: disputes,
                // US-1210: advance each cursor only to a value that keeps a
                // dropped (undecodable) row behind it. A failed best-effort
                // fetch yields nil → that table's watermark holds.
                itemCursor: Self.safeCursor(itemsFetch),
                photoCursor: photosFetch.flatMap { Self.safeCursor($0) },
                saleCursor: salesFetch.flatMap { Self.safeCursor($0) },
                expenseCursor: expensesFetch.flatMap { Self.safeCursor($0) },
                disputeCursor: disputesFetch.flatMap { Self.safeCursor($0) },
                listingCursor: listingsFetch.flatMap { Self.safeCursor($0) }
            ))
        } catch {
            return .failure(error)
        }
    }

    /// Result of a ``paginatedFetch`` — the decoded rows plus, when an `idOf`
    /// row-identity extractor was supplied, the cursor timestamps of every raw
    /// row split into those that decoded vs. those the resilient decoder dropped
    /// (US-1210). The split feeds ``safeCursor(_:)`` so the watermark never
    /// advances past a dropped row.
    private struct PagedFetch<T> {
        let rows: [T]
        let decodedCursors: [String]
        let droppedCursors: [String]
    }

    /// Paginated, watermark-filtered fetch. Loops `range()` pages until a page
    /// comes back short of `pageSize` (drained), advancing by raw row count so
    /// a resilient decode that drops a bad row can't stop pagination early.
    ///
    /// When `idOf` is supplied, each page's raw JSON is scanned (US-1210) to
    /// record the `cursor` value of every row and whether it decoded, so the
    /// caller can compute a drop-safe watermark.
    private func paginatedFetch<T>(
        table: String,
        columns: String,
        cursor: String,
        watermark: String?,
        scopeUserId: String? = nil,
        decode: (Data) -> [T],
        idOf: ((T) -> String)? = nil
    ) async throws -> PagedFetch<T> {
        var out: [T] = []
        var decodedCursors: [String] = []
        var droppedCursors: [String] = []
        var offset = 0
        while true {
            var query = SupabaseShared.client.from(table).select(columns)
            // US-670: workspace scoping for tables with a user_id column.
            if let scopeUserId { query = query.eq("user_id", value: scopeUserId) }
            if let watermark { query = query.gt(cursor, value: watermark) }
            let response = try await query
                .order(cursor, ascending: true)
                .range(from: offset, to: offset + Self.pageSize - 1)
                .execute()
            let decoded = decode(response.data)
            out.append(contentsOf: decoded)
            if let idOf {
                Self.splitCursors(
                    response.data,
                    cursorKey: cursor,
                    decodedIds: Set(decoded.map(idOf)),
                    decoded: &decodedCursors,
                    dropped: &droppedCursors
                )
            }
            let rawCount = Self.jsonArrayCount(response.data)
            if rawCount < Self.pageSize { break }
            offset += Self.pageSize
            if offset >= Self.maxRowsPerPass { break }
        }
        return PagedFetch(rows: out, decodedCursors: decodedCursors, droppedCursors: droppedCursors)
    }

    /// Count of elements in a top-level JSON array, used to decide when a page
    /// is drained independent of how many rows decoded cleanly.
    private static func jsonArrayCount(_ data: Data) -> Int {
        ((try? JSONSerialization.jsonObject(with: data)) as? [Any])?.count ?? 0
    }

    // MARK: - US-1210: drop-safe watermark

    /// Splits a raw JSON page's `cursor` values by whether the row decoded. A
    /// raw row whose `id` is absent from `decodedIds` (or whose `id`/`cursor`
    /// is missing) is treated as dropped, so its cursor keeps the watermark
    /// behind it.
    private static func splitCursors(
        _ data: Data,
        cursorKey: String,
        decodedIds: Set<String>,
        decoded: inout [String],
        dropped: inout [String]
    ) {
        guard let rows = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else { return }
        for row in rows {
            guard let cursorValue = row[cursorKey] as? String else { continue }
            if let id = row["id"] as? String, decodedIds.contains(id) {
                decoded.append(cursorValue)
            } else {
                dropped.append(cursorValue)
            }
        }
    }

    /// The cursor value to advance a watermark to that never skips a dropped
    /// (undecodable) row (US-1210). Returns the greatest *decoded* cursor that
    /// sorts strictly before the earliest *dropped* row, so the next delta pull
    /// (`gt(cursor, watermark)`) re-fetches the dropped row — and re-attempts its
    /// decode — once it becomes valid. With no drops this equals the page's max
    /// cursor (parity with the old `payload.map(\.cursor).max()`); `nil` means
    /// "don't advance". Cursor strings are ISO-8601 and compared lexically,
    /// matching ``SyncWatermark/advance(_:to:)``'s ordering.
    private static func safeCursor<T>(_ fetch: PagedFetch<T>) -> String? {
        guard let earliestDropped = fetch.droppedCursors.min() else {
            return fetch.decodedCursors.max()
        }
        return fetch.decodedCursors.filter { $0 < earliestDropped }.max()
    }

    /// Pure entrypoint for unit tests (US-1210): same logic as ``safeCursor(_:)``
    /// over explicit cursor lists.
    static func safeCursor(decodedCursors: [String], droppedCursors: [String]) -> String? {
        guard let earliestDropped = droppedCursors.min() else { return decodedCursors.max() }
        return decodedCursors.filter { $0 < earliestDropped }.max()
    }

    private static let itemColumns =
        "id,user_id,title,brand,sku,size,color,material,status,item_category,garment_type,garment_category,description,style,sourced_by,acquired_date,container,comp_set,source_id,location_bin,consignor_id,consignment_split_pct,target_price,acquired_price,grade_value,grade_label,certificate_url,grade_report_id,condition_notes,measurements,created_at,updated_at"

    private static let photoColumns =
        "id,inventory_item_id,photo_type,photo_url,thumbnail_url,storage_path,sort_order,bytes,created_at"

    private static let saleColumns =
        "id,inventory_item_id,sale_price,platform_fees,payment_processing_fees,shipping_collected,shipping_cost,grading_cost,other_costs,tax,net_profit,status,sale_date,buyer_username,created_at"

    // US-750 / 00266: includes the inventory_item_id + listing_id attribution links.
    private static let expenseColumns =
        "id,category,description,amount,spent_on,inventory_item_id,listing_id,created_at"

    /// Full listings projection. Drives BOTH the cached market (listing) price
    /// per item AND the local LocalListing mirror that the item canvas reads to
    /// decide whether to show "Edit live listing" (revisable Sell API offer) vs
    /// "Edit on eBay" (eBay-native, no offer). US-1221: delta on `updated_at`
    /// (the trigger bumps it on every edit, incl. eBay-driven price/status
    /// changes) instead of a whole-table fetch every pass.
    // NOTE: the listings table has NO `ended_at` column — selecting it 400s the
    // WHOLE query (PostgREST), which silently zeroes the listings sync (no
    // LocalListing rows → the item canvas never shows "Edit live listing"). Only
    // list columns proven to exist on `listings` (00002 + flipdesk migrations).
    private static let listingColumns =
        "id,inventory_item_id,platform,platform_listing_id,platform_offer_id,listing_url,listing_price,listing_status,listed_at,listing_origin,created_at,updated_at"

    /// US-1244: listing statuses that represent a currently-live listing (vs
    /// draft/ended/sold). Lowercased for case-insensitive comparison.
    static let liveListingStatuses: Set<String> = ["active", "relisted"]

    /// US-1244: choose each item's market-value price from its LIVE listing
    /// (active/relisted) when one exists, falling back to the latest of any
    /// status only when none is live. A live listing always beats a non-live one
    /// regardless of timestamp; within the same liveness class the newer
    /// `listed_at`/`created_at` wins. Pure + static so the selection is
    /// unit-testable without a network pull.
    static func selectListingPrices(
        _ rows: [(itemId: String, price: Double, at: Date, isLive: Bool)]
    ) -> [String: Double] {
        var prices: [String: Double] = [:]
        var at: [String: Date] = [:]
        var live: [String: Bool] = [:]
        for r in rows {
            if let prevAt = at[r.itemId] {
                let prevLive = live[r.itemId] ?? false
                if prevLive && !r.isLive { continue }            // live beats non-live
                if prevLive == r.isLive && prevAt >= r.at { continue }  // same class → newer wins
            }
            at[r.itemId] = r.at
            prices[r.itemId] = r.price
            live[r.itemId] = r.isLive
        }
        return prices
    }

    struct RemoteListing: Decodable, Sendable {
        let id: String
        let inventory_item_id: String
        let platform: String?
        let platform_listing_id: String?
        let platform_offer_id: String?
        let listing_url: String?
        let listing_price: Double?
        let listing_status: String?
        let listed_at: String?
        let listing_origin: String?
        let created_at: String?
        let updated_at: String?
    }

    static func decodeListingsResiliently(_ data: Data) -> [RemoteListing] {
        guard let rows = try? JSONDecoder().decode(
            [Failable<RemoteListing>].self, from: data
        ) else { return [] }
        return rows.compactMap(\.value)
    }

    // US-819: minimal `disputes` projection — just enough to badge a grade row
    // and pick the latest dispute per report.
    private static let disputeColumns =
        "id,grade_report_id,status,updated_at,created_at"

    /// Wire-shape `disputes` row. Owner-scoped via RLS (`user_id = auth.uid()`).
    struct RemoteDispute: Decodable, Sendable {
        let id: String
        let grade_report_id: String
        let status: String
        let updated_at: String?
        let created_at: String?
    }

    static func decodeDisputesResiliently(_ data: Data) -> [RemoteDispute] {
        guard let rows = try? JSONDecoder().decode(
            [Failable<RemoteDispute>].self, from: data
        ) else { return [] }
        return rows.compactMap(\.value)
    }

    /// Wrapper that decodes to nil instead of throwing.
    private struct Failable<T: Decodable>: Decodable {
        let value: T?
        init(from decoder: Decoder) throws {
            value = try? decoder.singleValueContainer().decode(T.self)
        }
    }

    static func decodeItemsResiliently(_ data: Data) -> [RemoteInventoryItem] {
        guard let rows = try? JSONDecoder().decode(
            [Failable<RemoteInventoryItem>].self, from: data
        ) else { return [] }
        let items = rows.compactMap(\.value)
        let dropped = rows.count - items.count
        if dropped > 0 {
            logErrorStatic("skipped \(dropped) undecodable inventory row(s)")
        }
        return items
    }

    static func decodePhotosResiliently(_ data: Data) -> [RemoteItemPhoto] {
        guard let rows = try? JSONDecoder().decode(
            [Failable<RemoteItemPhoto>].self, from: data
        ) else { return [] }
        return rows.compactMap(\.value)
    }

    static func decodeSalesResiliently(_ data: Data) -> [RemoteSaleRow] {
        guard let rows = try? JSONDecoder().decode(
            [Failable<RemoteSaleRow>].self, from: data
        ) else { return [] }
        return rows.compactMap(\.value)
    }

    static func decodeExpensesResiliently(_ data: Data) -> [RemoteExpenseRow] {
        guard let rows = try? JSONDecoder().decode(
            [Failable<RemoteExpenseRow>].self, from: data
        ) else { return [] }
        return rows.compactMap(\.value)
    }

    /// Shared ISO-8601 date parse used by the merge actor + realtime path.
    static func parseDate(_ s: String) -> Date {
        if let d = isoFull.date(from: s) { return d }
        if let d = isoPlain.date(from: s) { return d }
        return .now
    }

    private static let isoFull: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain = ISO8601DateFormatter()

    // MARK: - Realtime (US-198) — reuses the shared background context

    public func applyRealtimeInventoryUpsert(record: Data) async {
        do {
            let remote = try JSONDecoder().decode(RemoteInventoryItem.self, from: record)
            await mergeActor.mergeSingleInventory(remote)
        } catch {
            logError("realtime inventory upsert decode failed: \(error)")
        }
    }

    public func applyRealtimeInventoryDelete(id: String) async {
        await mergeActor.deleteInventory(id: id)
    }

    // MARK: - Flush (US-640)

    func flushPending() async {
        guard !isFlushing, !isStopping else { return }
        isFlushing = true
        defer { isFlushing = false }

        let allMutations = await snapshotMutations()
        // US-1208: a CREATE still in the queue means its row may not exist on the
        // server yet — it's either still retrying OR has exhausted its budget and
        // is stuck. Any UPDATE/DELETE targeting that same id must NOT flush ahead
        // of it: otherwise the replay runs `… WHERE id=?` against a row the server
        // doesn't have, PostgREST returns 200 affecting 0 rows (no error), and the
        // edit is silently dequeued and permanently lost. Compute the blocked set
        // from the FULL queue (incl. stuck creates past maxRetries), not just the
        // retry-eligible slice below.
        var unconfirmedCreateIds = Self.unconfirmedCreateTargetIds(allMutations)

        // Skip mutations that have exhausted their auto-retry budget; they stay
        // queued for the inspector (US-641).
        let mutations = allMutations.filter { $0.retryCount < Self.maxRetries }
        guard !mutations.isEmpty else {
            await refreshPendingCount()
            return
        }

        await statusStore.set(.syncing)
        for mutation in mutations {
            // US-1147: stop cleanly on teardown — replays are idempotent so the
            // remaining mutations simply flush on the next start/sync.
            if isStopping { break }
            // US-1208: defer an edit whose create hasn't been confirmed yet; it
            // stays queued and flushes on a later pass once the create lands.
            if Self.shouldDeferDependent(mutation, unconfirmedCreateIds: unconfirmedCreateIds) {
                continue
            }
            let succeeded = await apply(mutation)
            // A just-confirmed create unblocks dependent edits queued behind it
            // so they can still flush in THIS pass.
            if succeeded, Self.isCreateKind(mutation.kind), let target = mutation.targetId {
                unconfirmedCreateIds.remove(target)
            }
        }
        await refreshPendingCount()
    }

    // MARK: - US-1208: create-before-edit replay ordering

    /// CREATE mutation kinds whose target row may not exist on the server until
    /// the create confirms.
    static func isCreateKind(_ kind: String) -> Bool {
        switch MutationKind(rawValue: kind) {
        case .createInventoryItem, .createSale, .createExpense, .createListing: return true
        default: return false
        }
    }

    /// UPDATE/DELETE mutation kinds that target an existing row by id, and so
    /// must not flush ahead of a still-pending create of that same row.
    static func isDependentEdit(_ kind: String) -> Bool {
        switch MutationKind(rawValue: kind) {
        case .updateInventoryItem, .deleteInventoryItem, .deleteExpense: return true
        default: return false
        }
    }

    /// Target ids of CREATE mutations still in the queue — their server row may
    /// not exist yet (US-1208).
    static func unconfirmedCreateTargetIds(_ queue: [PendingMutationSnapshot]) -> Set<String> {
        Set(queue.filter { isCreateKind($0.kind) }.compactMap(\.targetId))
    }

    /// True when `mutation` is an edit that must wait for a still-pending create
    /// of the same row (US-1208).
    static func shouldDeferDependent(
        _ mutation: PendingMutationSnapshot, unconfirmedCreateIds: Set<String>
    ) -> Bool {
        guard isDependentEdit(mutation.kind), let target = mutation.targetId else { return false }
        return unconfirmedCreateIds.contains(target)
    }

    /// Replays one queued mutation against the server. On success the mutation
    /// is dequeued (returns true); on a retryable failure `retryCount`/`lastError`
    /// advance and it stays queued; on a terminal failure it is marked stuck
    /// immediately (US-1221) without consuming the transient-retry budget.
    @discardableResult
    private func apply(_ mutation: PendingMutationSnapshot) async -> Bool {
        guard let kind = MutationKind(rawValue: mutation.kind) else {
            // An unknown kind can never become known on retry — terminal.
            await markStuck(id: mutation.id, error: "unknown mutation kind \(mutation.kind)")
            return false
        }
        do {
            switch kind {
            case .createInventoryItem:
                // Upsert (the offline payload carries a client-generated id) so
                // a retry after a partial success can't create a duplicate.
                try await replayUpsert(table: "inventory_items", payload: mutation.payload)
            case .createListing:
                try await replayInsert(table: "listings", payload: mutation.payload)
            case .createSale:
                // Upsert (the offline payload carries a client-generated id) so a
                // retry after a partial success can't double-record the sale.
                try await replayUpsert(table: "sales", payload: mutation.payload)
            case .createExpense:
                // Same client-id idempotency as createSale/createInventoryItem.
                try await replayUpsert(table: "flipdesk_expenses", payload: mutation.payload)
            case .deleteExpense:
                try await replayDelete(table: "flipdesk_expenses", id: mutation.targetId)
            case .updateInventoryItem:
                try await replayUpdate(table: "inventory_items", payload: mutation.payload, id: mutation.targetId)
            case .deleteInventoryItem:
                try await replayDelete(table: "inventory_items", id: mutation.targetId)
            case .deletePhoto:
                try await replayDelete(table: "item_photos", id: mutation.targetId)
            case .uploadPhoto:
                try await replayUploadPhoto(payload: mutation.payload)
            }
            await deleteMutation(id: mutation.id)  // server-confirmed → dequeue
            return true
        } catch let replayError as SyncReplayError where replayError.isTerminal {
            // US-1221: a permanent replay error (missing target row, staged file
            // gone, malformed storage URL) will never succeed on retry — surface
            // it for manual attention immediately instead of burning all 6
            // transient retries first.
            await markStuck(id: mutation.id, error: replayError.localizedDescription)
            return false
        } catch {
            await markFailed(id: mutation.id, error: error.localizedDescription)
            return false
        }
    }

    // MARK: - Mutation replay handlers

    private func replayInsert(table: String, payload: Data) async throws {
        let row = try JSONDecoder().decode([String: AnyJSON].self, from: payload)
        try await SupabaseShared.client.from(table).insert(row).execute()
    }

    private func replayUpsert(table: String, payload: Data) async throws {
        let row = try JSONDecoder().decode([String: AnyJSON].self, from: payload)
        try await SupabaseShared.client.from(table).upsert(row).execute()
    }

    private func replayUpdate(table: String, payload: Data, id: String?) async throws {
        guard let id else { throw SyncReplayError.missingTarget }
        let row = try JSONDecoder().decode([String: AnyJSON].self, from: payload)
        try await SupabaseShared.client.from(table).update(row).eq("id", value: id).execute()
    }

    private func replayDelete(table: String, id: String?) async throws {
        guard let id else { throw SyncReplayError.missingTarget }
        try await SupabaseShared.client.from(table).delete().eq("id", value: id).execute()
    }

    /// Replays a queued photo upload: re-uploads the staged JPEG to Storage
    /// (idempotent via x-upsert) then upserts the `item_photos` row by its
    /// client-generated id, so a retry never double-inserts.
    private func replayUploadPhoto(payload: Data) async throws {
        struct UploadPayload: Decodable {
            let inventory_item_id: String
            let user_id: String
            let slot: String
            let storage_path: String
            let local_file_url: String
            let photo_id: String?
            // US-289: capture-time + reconcile session carried through the
            // offline queue so a retried upload doesn't lose them.
            let captured_at: String?
            let reconcile_session_id: String?
        }
        let p = try JSONDecoder().decode(UploadPayload.self, from: payload)
        let fileURL = URL(fileURLWithPath: p.local_file_url)
        guard let data = try? Data(contentsOf: fileURL) else {
            // The staged bytes are gone — nothing to replay. Terminal.
            throw SyncReplayError.missingLocalFile
        }
        guard let token = await SupabaseShared.currentAccessToken() else {
            throw SyncReplayError.notSignedIn
        }

        // US-979: route sensitive slots (tag/grading-label close-ups) to the
        // PRIVATE bucket, mirroring the direct-upload path, so an offline-queued
        // retry never lands a PII photo in the public bucket.
        let slot = PhotoSlotType(rawValue: p.slot)
        let photoType = slot?.serverPhotoType ?? p.slot
        let bucket = slot?.storageBucket ?? PhotoStorageBucket.bucket(forServerType: photoType)
        guard let storageURL = Self.storageObjectURL(path: p.storage_path, bucket: bucket) else {
            throw SyncReplayError.invalidStorageURL
        }
        var request = URLRequest(url: storageURL)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        request.setValue("true", forHTTPHeaderField: "x-upsert")
        let (_, response) = try await Self.storageUploadSession.upload(for: request, from: data)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw SyncReplayError.storageUpload(status: http.statusCode)
        }

        let bytes = (try? FileManager.default.attributesOfItem(atPath: fileURL.path)[.size] as? Int) ?? nil
        // Sensitive photos get NO public URL — display/edge re-sign from path.
        let photoURL = PhotoStorageBucket.isSensitive(serverType: photoType)
            ? ""
            : Self.storagePublicURL(path: p.storage_path)
        var row: [String: AnyJSON] = [
            "inventory_item_id": .string(p.inventory_item_id),
            "photo_type": .string(photoType),
            "storage_path": .string(p.storage_path),
            "photo_url": .string(photoURL),
            "sort_order": .integer(0),
            "bytes": .integer(bytes ?? 0),
        ]
        if let photoId = p.photo_id { row["id"] = .string(photoId) }
        // US-289: preserve capture-time + reconcile session through replay.
        if let capturedAt = p.captured_at { row["captured_at"] = .string(capturedAt) }
        if let sessionId = p.reconcile_session_id {
            row["reconcile_session_id"] = .string(sessionId)
        }
        try await SupabaseShared.client.from("item_photos").upsert(row).execute()

        // Clean up the staged bytes now that they're durably uploaded.
        try? FileManager.default.removeItem(at: fileURL)
    }

    /// Dedicated session for raw Storage uploads that set Authorization / apikey
    /// headers. Deliberately NOT `URLSession.shared`: the shared session is the
    /// one Sentry swizzles for auto HTTP breadcrumbs, so a signed-storage URL +
    /// bearer creds would be captured into a crumb. Routing these authenticated
    /// uploads through a private session keeps them off that swizzled path
    /// (breadcrumb scrubbing is the second line of defense). The ephemeral
    /// config also holds no on-disk cache/cookies for these requests. (US-990)
    private static let storageUploadSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        return URLSession(configuration: config)
    }()

    private static func storageObjectURL(path: String, bucket: String) -> URL? {
        StorageURL.object(base: AppConfig.supabaseURL, bucket: bucket, path: path)
    }

    private static func storagePublicURL(path: String) -> String {
        // Only called for non-sensitive photos (public bucket); sensitive ones
        // persist an empty `photo_url` instead (US-979).
        StorageURL.publicObject(base: AppConfig.supabaseURL, bucket: PhotoStorageBucket.publicBucket, path: path)?
            .absoluteString ?? ""
    }

    enum SyncReplayError: LocalizedError {
        case missingTarget
        case missingLocalFile
        case notSignedIn
        case storageUpload(status: Int)
        case invalidStorageURL

        var errorDescription: String? {
            switch self {
            case .missingTarget: return "Missing target row id for this change."
            case .missingLocalFile: return "The staged photo is no longer available."
            case .notSignedIn: return "Sign-in expired before this change could sync."
            case .storageUpload(let status): return "Photo upload failed (HTTP \(status))."
            case .invalidStorageURL: return "Storage isn't configured correctly."
            }
        }

        /// US-1221: cases that can never succeed on a retry, so they should be
        /// flagged stuck (manual attention) immediately rather than consuming the
        /// shared transient-retry budget over 6 passes. `notSignedIn` (re-auth on
        /// next foreground) and `storageUpload` (a server-side 5xx may clear) stay
        /// transient and keep retrying.
        var isTerminal: Bool {
            switch self {
            case .missingTarget, .missingLocalFile, .invalidStorageURL: return true
            case .notSignedIn, .storageUpload: return false
            }
        }
    }

    // MARK: - Pending-changes inspector support (US-641)

    /// Sendable snapshot of a queued mutation for the inspector + flush loop.
    struct PendingMutationSnapshot: Identifiable, Sendable, Equatable {
        let id: String
        let kind: String
        let payload: Data
        let targetId: String?
        let retryCount: Int
        let lastError: String?
        let lastAttemptAt: Date?
        let createdAt: Date

        /// A mutation is "failed" once it has a recorded error; otherwise it's
        /// queued/in-flight.
        var isFailed: Bool { lastError != nil }
    }

    /// Snapshot the full queue for the inspector.
    func pendingMutations() async -> [PendingMutationSnapshot] {
        await snapshotMutations()
    }

    /// Re-attempt a single mutation immediately: clears its error/retry budget
    /// then applies it.
    func retryMutation(id: String) async {
        await pendingActor.clearErrorAndResetRetry(id: id)
        let snapshot = await snapshotMutations().first { $0.id == id }
        if let snapshot { await apply(snapshot) }
        await refreshPendingCount()
    }

    /// Drop a stuck mutation from the queue (US-641 discard).
    func discardMutation(id: String) async {
        await deleteMutation(id: id)
        await refreshPendingCount()
    }

    // MARK: - SwiftData helpers

    /// US-1165: the offline-queue SwiftData reads/writes below now run on the
    /// background ``PendingMutationActor`` instead of hopping to ``MainActor``
    /// for each touch. The engine still hops to main only to publish status
    /// counts to ``SyncStatusStore`` (see ``refreshPendingCount()``).

    private func snapshotMutations() async -> [PendingMutationSnapshot] {
        await pendingActor.snapshot()
    }

    private func deleteMutation(id: String) async {
        await pendingActor.delete(id: id)
    }

    private func markFailed(id: String, error: String) async {
        await pendingActor.markFailed(id: id, error: error, maxRetries: Self.maxRetries)
    }

    /// US-1221: flag a mutation as stuck (needs manual retry/discard) without
    /// stepping through the 6-attempt transient-retry budget — used for terminal
    /// replay errors that can never succeed. Pins `retryCount` to `maxRetries` so
    /// the flush loop skips it and ``stuckMutationCount()`` surfaces it.
    private func markStuck(id: String, error: String) async {
        await pendingActor.markStuck(id: id, error: error, maxRetries: Self.maxRetries)
    }

    private func pendingMutationCount() async -> Int {
        await pendingActor.pendingCount()
    }

    /// Count of mutations that have exhausted their auto-retry budget and now
    /// need the user's attention (US-1147).
    private func stuckMutationCount() async -> Int {
        await pendingActor.stuckCount(maxRetries: Self.maxRetries)
    }

    private func refreshPendingCount() async {
        let count = await pendingMutationCount()
        let stuck = await stuckMutationCount()
        await statusStore.setPendingCount(count, stuck: stuck)
    }

    // MARK: - Logging

    private func logError(_ message: String) {
        Self.logErrorStatic(message)
    }

    fileprivate static func logErrorStatic(_ message: String) {
        #if DEBUG
        print("[SyncEngine] \(message)")
        #endif
    }
}

// MARK: - Status store

/// Main-actor observable that backs ``SyncStatusBar``.
@MainActor
@Observable
final class SyncStatusStore {
    enum Phase: Equatable {
        case idle
        case syncing
        case pending
        case offline
        case reconnecting
    }

    var phase: Phase = .idle
    var pendingCount: Int = 0
    /// US-1147: mutations that exhausted their auto-retry budget and need the
    /// user to retry/discard them via the inspector. Surfaced distinctly from
    /// the routine pending count so a genuinely stuck change isn't mistaken for
    /// "still syncing".
    var stuckCount: Int = 0

    func set(_ next: Phase) {
        phase = next
    }

    func setPendingCount(_ count: Int, stuck: Int = 0) {
        pendingCount = count
        stuckCount = stuck
        if phase == .idle, count > 0 {
            phase = .pending
        } else if phase == .pending, count == 0 {
            phase = .idle
        }
    }
}
