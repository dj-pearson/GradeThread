package com.gradethread.app.sync

import android.content.Context
import com.gradethread.app.platform.workspace.WorkspaceScope
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.ExpenseEntity
import com.gradethread.app.sync.db.ItemPhotoEntity
import com.gradethread.app.sync.db.ListingEntity
import com.gradethread.app.sync.db.PayoutEntity
import com.gradethread.app.sync.db.SaleEntity
import com.gradethread.app.sync.db.SourceEntity
import dagger.hilt.android.qualifiers.ApplicationContext
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.postgrest.query.Order
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-2151: the production entry point for sync.
 *
 * Builds the tenant-scoped [SyncCoordinator.TablePlan]s and runs them. Call
 * on sign-in, on foreground, and from pull-to-refresh.
 */
@Singleton
class SyncService @Inject constructor(
    @ApplicationContext private val context: Context,
    private val client: SupabaseClient,
    private val db: GradeThreadDb,
) {

    private val watermark = SyncWatermark(context)
    private val merger = SyncMerger(db)

    /**
     * US-2792: "a pull is in flight", observable.
     *
     * SyncCoordinator.isRunning is the same fact but reads mutex.isLocked,
     * which nothing can subscribe to — and the coordinator is built PER PULL
     * inside [pull], so a flow on it would belong to an object nothing
     * outside can reach. This class is the @Singleton, so the flag lives
     * here, where a ViewModel can actually observe it.
     */
    private val syncingFlow = kotlinx.coroutines.flow.MutableStateFlow(false)
    val syncing: kotlinx.coroutines.flow.StateFlow<Boolean> = syncingFlow

    /** Active workspace, else self — matching every other tenant-scoped read. */
    private fun ownerId(): String? =
        client.auth.currentUserOrNull()?.id?.let { WorkspaceScope.tenantOwnerId(it) }

    /**
     * @return null when signed out — there is no tenant to scope to, and an
     * unscoped pull would be a cross-tenant read.
     */
    suspend fun pull(): SyncCoordinator.Outcome? = withContext(Dispatchers.IO) {
        val owner = ownerId() ?: return@withContext null
        syncingFlow.value = true
        try {
            coordinator(owner).pullAll()
        } finally {
            // finally, not after the call: a thrown pull must not leave the
            // bar saying "Syncing…" for the rest of the session.
            syncingFlow.value = false
        }
    }

    private fun coordinator(owner: String) = SyncCoordinator(
        tables = listOf(
            // Items first: photos, sales and listings all FK to inventory_items,
            // so pulling children first would insert rows whose parent isn't
            // there yet and trip the foreign key.
            itemsPlan(owner),
            photosPlan(owner),
            sourcesPlan(owner),
            listingsPlan(owner),
            salesPlan(owner),
            expensesPlan(owner),
            payoutsPlan(owner),
        ),
        readCursor = { table -> watermark.cursor(table) },
        advanceCursor = { table, cursor -> watermark.advance(table, cursor) },
    )

    private fun sourcesPlan(owner: String) = SyncCoordinator.TablePlan(
        table = SyncWatermark.Table.SOURCES,
        fetchPage = { cursor, offset -> page("sources", owner, cursor, offset) },
        decode = { raw -> (raw as? JsonObject)?.let(SyncRows::decodeSourceRow) },
        apply = { rows -> merger.apply(SyncMerger.PulledBatch(sources = rows)) },
    )

    private fun listingsPlan(owner: String) = SyncCoordinator.TablePlan(
        table = SyncWatermark.Table.LISTINGS,
        fetchPage = { cursor, offset -> page("listings", owner, cursor, offset) },
        decode = { raw -> (raw as? JsonObject)?.let(SyncRows::decodeListingRow) },
        apply = { rows -> merger.apply(SyncMerger.PulledBatch(listings = rows)) },
    )

    /**
     * US-1365: payouts, so reconciliation works offline.
     *
     * Pulled like any other table rather than fetched on demand: the whole
     * point of the reconciliation screen is comparing what was recorded against
     * what was actually deposited, and that has to hold up on a train.
     */
    private fun payoutsPlan(owner: String) = SyncCoordinator.TablePlan(
        table = SyncWatermark.Table.PAYOUTS,
        fetchPage = { cursor, offset -> page("ebay_payouts", owner, cursor, offset) },
        decode = { raw -> (raw as? JsonObject)?.let(SyncRows::decodePayoutRow) },
        apply = { rows -> merger.apply(SyncMerger.PulledBatch(payouts = rows)) },
    )

    private fun salesPlan(owner: String) = SyncCoordinator.TablePlan(
        table = SyncWatermark.Table.SALES,
        fetchPage = { cursor, offset -> page("sales", owner, cursor, offset) },
        decode = { raw -> (raw as? JsonObject)?.let(SyncRows::decodeSaleRow) },
        apply = { rows -> merger.apply(SyncMerger.PulledBatch(sales = rows)) },
    )

    private fun expensesPlan(owner: String) = SyncCoordinator.TablePlan(
        table = SyncWatermark.Table.EXPENSES,
        // The server table is `flipdesk_expenses`, NOT `expenses` — the local
        // Room table is named `expenses`, and the mismatch is easy to miss.
        fetchPage = { cursor, offset -> page("flipdesk_expenses", owner, cursor, offset) },
        decode = { raw -> (raw as? JsonObject)?.let(SyncRows::decodeExpenseRow) },
        apply = { rows -> merger.apply(SyncMerger.PulledBatch(expenses = rows)) },
    )

    private fun itemsPlan(owner: String) = SyncCoordinator.TablePlan(
        table = SyncWatermark.Table.ITEMS,
        fetchPage = { cursor, offset -> page("inventory_items", owner, cursor, offset) },
        // Reuses the realtime decoder — one row shape, one place to change it.
        decode = { raw -> (raw as? JsonObject)?.let(RealtimeRows::decodeInventoryRow) },
        apply = { rows -> merger.apply(SyncMerger.PulledBatch(items = rows)) },
    )

    private fun photosPlan(owner: String) = SyncCoordinator.TablePlan(
        table = SyncWatermark.Table.PHOTOS,
        // item_photos has no user_id: ownership is via the parent item, so the
        // scope is an inner join on inventory_items rather than a direct eq.
        fetchPage = { cursor, offset -> photoPage(owner, cursor, offset) },
        decode = { raw -> (raw as? JsonObject)?.let(SyncRows::decodePhotoRow) },
        apply = { rows -> merger.apply(SyncMerger.PulledBatch(photos = rows)) },
    )

    /**
     * One page, ordered by `updated_at` ASC and scoped to [owner].
     *
     * The order is not cosmetic — [SyncPull.safeCursor] and the monotonic
     * watermark both assume ascending cursors.
     */
    private suspend fun page(
        table: String,
        owner: String,
        cursor: String?,
        offset: Int,
    ): List<JsonElement> = client.from(table).select {
        filter {
            eq("user_id", owner)
            // Strictly greater-than: a row exactly at the cursor was already
            // consumed, and re-fetching it every pass would never drain.
            cursor?.let { gt("updated_at", it) }
        }
        order("updated_at", Order.ASCENDING)
        range(offset.toLong(), (offset + SyncPull.PAGE_SIZE - 1).toLong())
    }.decodeList<JsonObject>()

    /**
     * US-2207: the surviving server ids for one table, or null when the set
     * cannot be TRUSTED as complete.
     *
     * Ported from the iOS `fetchServerIds` contract, and the null cases are the
     * whole design — [DeleteReconciler] PRUNES against whatever this returns,
     * so an incomplete set does not degrade the feature, it deletes live rows.
     *
     * Three ways to be incomplete, all returning null:
     *
     *  - **signed out / scope unresolved.** An unscoped id-scan goes out
     *    unauthenticated, RLS answers with zero rows, and zero rows looks
     *    exactly like "this account has nothing left" — which would prune the
     *    entire local mirror. Costing one reconcile interval is the cheap side
     *    of that trade (iOS learned this as US-2337);
     *  - **any error.** Offline, a 500, a decode failure — all of them mean we
     *    did not see the server's set;
     *  - **the row cap.** PostgREST silently truncates a read at `db-max-rows`
     *    and reports it only in a `Content-Range` header the client does not
     *    surface, so pagination has to prove completeness by reading a SHORT
     *    page. If the scan is still returning full pages at
     *    [MAX_ROWS_PER_PASS], the set holds only the lowest ids and pruning
     *    against it would delete every local row above the cap — which the next
     *    delta pull re-fetches and the next reconcile prunes again. Rows would
     *    visibly come and go for large accounts.
     *
     * Ordered by `id` so successive pages do not overlap or skip; the pull's
     * `updated_at` ordering is wrong here because a row updated mid-scan would
     * move between pages.
     */
    suspend fun survivingIds(table: DeleteReconciler.Table): Set<String>? =
        withContext(Dispatchers.IO) {
            val owner = ownerId() ?: return@withContext null
            val ids = mutableSetOf<String>()
            var offset = 0
            try {
                while (true) {
                    val page = client.from(table.remote).select(
                        // listings / item_photos carry no user_id — RLS scopes
                        // them through the parent item, so the filter below is
                        // applied only where the column exists.
                        Columns.raw("id"),
                    ) {
                        filter { if (table.userScoped) eq("user_id", owner) }
                        order("id", Order.ASCENDING)
                        range(offset.toLong(), (offset + ID_PAGE_SIZE - 1).toLong())
                    }.decodeList<RemoteId>()

                    page.forEach { ids.add(it.id) }
                    offset += page.size
                    when (idScanStep(received = page.size, scanned = offset)) {
                        ScanStep.COMPLETE -> return@withContext ids
                        ScanStep.ABANDON -> return@withContext null
                        ScanStep.CONTINUE -> Unit
                    }
                }
                @Suppress("UNREACHABLE_CODE")
                ids
            } catch (_: Throwable) {
                null
            }
        }

    @Serializable
    private data class RemoteId(val id: String)

    /** What [survivingIds] does after reading one page of ids. */
    enum class ScanStep {
        /** Read another page. */
        CONTINUE,

        /** Short page — the set is provably complete and safe to prune against. */
        COMPLETE,

        /** The set cannot be trusted; skip pruning this table entirely. */
        ABANDON,
    }

    companion object {
        /** Ids per id-scan page. Matches the iOS scan and [SyncPull.PAGE_SIZE]. */
        const val ID_PAGE_SIZE = 500

        /**
         * Hard ceiling on one reconcile pass. Reaching it means the id set is
         * truncated, so the pass is ABANDONED rather than trusted — see
         * [survivingIds].
         */
        const val MAX_ROWS_PER_PASS = 50_000

        /**
         * The pagination decision, pulled out as a pure function because it is
         * the part that can be catastrophically wrong (US-2207).
         *
         * Every branch here is a claim about COMPLETENESS, and the caller
         * deletes rows on the strength of it:
         *
         *  - a SHORT page is the only proof the server has no more ids. Treating
         *    a full page as the end would silently truncate the set and prune
         *    every row past it;
         *  - a full page AT the cap means more rows almost certainly exist, so
         *    the set holds only the lowest ids. Pruning against it would delete
         *    every local row above the cap, the next delta pull would re-fetch
         *    them, and the next reconcile would prune them again — rows visibly
         *    appearing and disappearing on exactly the largest accounts;
         *  - **zero rows is COMPLETE, not empty-and-suspicious.** An account
         *    really can have deleted everything. The dangerous version of an
         *    empty set — an unscoped, unauthenticated read that RLS answers with
         *    nothing — is refused earlier, by resolving the owner before the
         *    first request rather than by second-guessing the count here.
         */
        fun idScanStep(
            received: Int,
            scanned: Int,
            pageSize: Int = ID_PAGE_SIZE,
            cap: Int = MAX_ROWS_PER_PASS,
        ): ScanStep = when {
            received < pageSize -> ScanStep.COMPLETE
            scanned >= cap -> ScanStep.ABANDON
            else -> ScanStep.CONTINUE
        }
    }

    private suspend fun photoPage(
        owner: String,
        cursor: String?,
        offset: Int,
    ): List<JsonElement> = client.from("item_photos").select(
        // Ownership via the parent row — item_photos carries no user_id, and
        // an unscoped read here would be a cross-tenant leak.
        io.github.jan.supabase.postgrest.query.Columns.raw("*, inventory_items!inner(user_id)"),
    ) {
        filter {
            eq("inventory_items.user_id", owner)
            cursor?.let { gt("updated_at", it) }
        }
        order("updated_at", Order.ASCENDING)
        range(offset.toLong(), (offset + SyncPull.PAGE_SIZE - 1).toLong())
    }.decodeList<JsonObject>()
}

/** US-2151: row decoders for the pull that realtime doesn't already cover. */
object SyncRows {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    @Serializable
    private data class RemotePhotoRow(
        val id: String,
        @SerialName("inventory_item_id") val inventoryItemId: String,
        @SerialName("photo_type") val photoType: String? = null,
        // US-2469: the open-text qualifier. Absent on a pre-00587 row and on a
        // type that takes none, which are the same thing to every reader.
        @SerialName("photo_role") val photoRole: String? = null,
        @SerialName("photo_url") val photoUrl: String? = null,
        @SerialName("thumbnail_url") val thumbnailUrl: String? = null,
        @SerialName("storage_path") val storagePath: String? = null,
        val width: Int? = null,
        val height: Int? = null,
        val bytes: Int? = null,
        @SerialName("sort_order") val sortOrder: Int? = null,
        @SerialName("created_at") val createdAt: String? = null,
    )

    /** Lenient: null on any decode failure, so one bad row can't fail a page. */
    fun decodePhotoRow(record: JsonObject): ItemPhotoEntity? = runCatching {
        val row = json.decodeFromJsonElement(RemotePhotoRow.serializer(), record)
        // A photo with no URL can't render and would show as a broken tile —
        // drop it rather than store it.
        val url = row.photoUrl?.takeIf { it.isNotBlank() } ?: return null
        ItemPhotoEntity(
            id = row.id.lowercase(),
            inventoryItemId = row.inventoryItemId.lowercase(),
            photoType = row.photoType ?: "detail",
            photoRole = row.photoRole?.takeIf { it.isNotBlank() },
            photoUrl = url,
            thumbnailUrl = row.thumbnailUrl,
            storagePath = row.storagePath,
            width = row.width,
            height = row.height,
            bytes = row.bytes,
            sortOrder = row.sortOrder ?: 0,
            createdAt = RealtimeRows.parseTimestamp(row.createdAt) ?: 0L,
            localBytesPath = null,
        )
    }.getOrNull()

    @Serializable
    private data class RemoteSourceRow(
        val id: String,
        @SerialName("user_id") val userId: String,
        val name: String? = null,
        @SerialName("source_type") val sourceType: String? = null,
        val notes: String? = null,
        @SerialName("archived_at") val archivedAt: String? = null,
        @SerialName("created_at") val createdAt: String? = null,
        @SerialName("updated_at") val updatedAt: String? = null,
    )

    fun decodeSourceRow(record: JsonObject): SourceEntity? = runCatching {
        val row = json.decodeFromJsonElement(RemoteSourceRow.serializer(), record)
        SourceEntity(
            id = row.id.lowercase(),
            userId = row.userId,
            name = row.name ?: "",
            sourceType = row.sourceType ?: "other",
            notes = row.notes,
            // NULL archived_at is the active flag, not missing data.
            archivedAt = RealtimeRows.parseTimestamp(row.archivedAt),
            createdAt = RealtimeRows.parseTimestamp(row.createdAt) ?: 0L,
            updatedAt = RealtimeRows.parseTimestamp(row.updatedAt) ?: 0L,
        )
    }.getOrNull()

    @Serializable
    private data class RemoteListingRow(
        val id: String,
        @SerialName("inventory_item_id") val inventoryItemId: String,
        val platform: String? = null,
        @SerialName("platform_listing_id") val platformListingId: String? = null,
        /**
         * US-1351: the Sell Inventory API offer id (00031). Non-nil ONLY for
         * listings GradeThread published itself — that is what makes a listing
         * revisable in place. Dropping it made every pulled listing look
         * eBay-native, so the publish path could never tell "revise here" from
         * "edit on eBay".
         */
        @SerialName("platform_offer_id") val platformOfferId: String? = null,
        @SerialName("listing_url") val listingUrl: String? = null,
        @SerialName("listing_price") val listingPrice: Double? = null,
        @SerialName("listing_status") val listingStatus: String? = null,
        @SerialName("listed_at") val listedAt: String? = null,
        /** US-1351/US-1973: eBay's availableQuantity mirror (00133). */
        val quantity: Int? = null,
        /**
         * US-1351/US-1086: `gradethread` | `ebay` (00232). The merge's
         * provenance input — without it every listing fell back to the
         * gradethread branch and an eBay-owned price could lose to a stale
         * local edit.
         */
        @SerialName("listing_origin") val listingOrigin: String? = null,
        /** US-1511: last outbound push failure, server-owned; cleared on success. */
        @SerialName("publish_error") val publishError: String? = null,
        val views: Int? = null,
        val watchers: Int? = null,
        @SerialName("created_at") val createdAt: String? = null,
        @SerialName("updated_at") val updatedAt: String? = null,
    )

    fun decodeListingRow(record: JsonObject): ListingEntity? = runCatching {
        val row = json.decodeFromJsonElement(RemoteListingRow.serializer(), record)
        ListingEntity(
            id = row.id.lowercase(),
            inventoryItemId = row.inventoryItemId.lowercase(),
            platform = row.platform ?: "other",
            platformListingId = row.platformListingId,
            platformOfferId = row.platformOfferId,
            externalUrl = row.listingUrl,
            listingPrice = row.listingPrice ?: 0.0,
            listingStatus = row.listingStatus ?: "draft",
            listedAt = RealtimeRows.parseTimestamp(row.listedAt),
            // `listings` carries no ended_at column — the field stays null here
            // rather than being guessed from status (iOS carries the same note).
            endedAt = null,
            viewsTotal = row.views,
            watchersCount = row.watchers,
            quantity = row.quantity,
            // US-1351: provenance is read STRAIGHT from the server column, never
            // guessed. A wrong origin silently flips which side owns price and
            // quantity (vault/20-domain/sync-source-of-truth.md); a null one is
            // a legacy row and the merge treats it as gradethread.
            listingOrigin = row.listingOrigin,
            publishError = row.publishError,
            createdAt = RealtimeRows.parseTimestamp(row.createdAt) ?: 0L,
            updatedAt = RealtimeRows.parseTimestamp(row.updatedAt) ?: 0L,
        )
    }.getOrNull()

    @Serializable
    private data class RemoteSaleRow(
        val id: String,
        @SerialName("inventory_item_id") val inventoryItemId: String,
        @SerialName("listing_id") val listingId: String? = null,
        @SerialName("sale_price") val salePrice: Double? = null,
        @SerialName("platform_fees") val platformFees: Double? = null,
        @SerialName("payment_processing_fees") val paymentProcessingFees: Double? = null,
        @SerialName("shipping_collected") val shippingCollected: Double? = null,
        @SerialName("shipping_cost") val shippingCost: Double? = null,
        @SerialName("grading_cost") val gradingCost: Double? = null,
        @SerialName("other_costs") val otherCosts: Double? = null,
        @SerialName("net_profit") val netProfit: Double? = null,
        /**
         * 00111: `completed` | `cancelled` | `refunded` | `pending`.
         *
         * NOT optional-by-accident. This column was missing from the decoder,
         * so every pulled sale took [SaleEntity]'s `completed` default and a
         * refunded order counted as revenue in every rollup — the exact thing
         * 00111 says all metrics MUST exclude. Absent (legacy row) still means
         * completed; see `SalePnL.isCompleted`.
         */
        val status: String? = null,
        @SerialName("buyer_username") val buyerUsername: String? = null,
        @SerialName("platform_order_id") val platformOrderId: String? = null,
        @SerialName("payout_reference") val payoutReference: String? = null,
        /** US-1365: what eBay actually paid out for this sale, when known. */
        @SerialName("payout_amount") val payoutAmount: Double? = null,
        @SerialName("sale_date") val saleDate: String? = null,
        @SerialName("sold_at") val soldAt: String? = null,
        @SerialName("shipped_at") val shippedAt: String? = null,
        @SerialName("tracking_number") val trackingNumber: String? = null,
        @SerialName("created_at") val createdAt: String? = null,
    )

    fun decodeSaleRow(record: JsonObject): SaleEntity? = runCatching {
        val row = json.decodeFromJsonElement(RemoteSaleRow.serializer(), record)
        SaleEntity(
            id = row.id.lowercase(),
            inventoryItemId = row.inventoryItemId.lowercase(),
            listingId = row.listingId?.lowercase(),
            salePrice = row.salePrice ?: 0.0,
            platformFees = row.platformFees ?: 0.0,
            paymentProcessingFees = row.paymentProcessingFees,
            shippingCollected = row.shippingCollected,
            shippingCost = row.shippingCost,
            gradingCost = row.gradingCost,
            otherCosts = row.otherCosts,
            tax = null,
            // Left as the server computed it. net_profit deliberately excludes
            // cost basis (which lives on inventory_items.acquired_price), so
            // recomputing it here from sale fields alone would be wrong.
            netProfit = row.netProfit,
            // Blank/absent → completed, matching the legacy-row rule the
            // rollups apply. Never silently dropped: see RemoteSaleRow.status.
            status = row.status?.takeIf { it.isNotBlank() } ?: "completed",
            buyerUsername = row.buyerUsername,
            platformOrderId = row.platformOrderId,
            payoutReference = row.payoutReference,
            payoutAmount = row.payoutAmount,
            saleDate = RealtimeRows.parseTimestamp(row.saleDate) ?: 0L,
            soldAt = RealtimeRows.parseTimestamp(row.soldAt),
            shippedAt = RealtimeRows.parseTimestamp(row.shippedAt),
            trackingNumber = row.trackingNumber,
            createdAt = RealtimeRows.parseTimestamp(row.createdAt) ?: 0L,
        )
    }.getOrNull()

    @Serializable
    private data class RemotePayoutRow(
        val id: String,
        @SerialName("payout_id") val payoutId: String,
        @SerialName("amount_cents") val amountCents: Int? = null,
        val currency: String? = null,
        val status: String? = null,
        @SerialName("payout_date") val payoutDate: String? = null,
        @SerialName("transaction_count") val transactionCount: Int? = null,
        @SerialName("updated_at") val updatedAt: String? = null,
    )

    fun decodePayoutRow(record: JsonObject): PayoutEntity? = runCatching {
        val row = json.decodeFromJsonElement(RemotePayoutRow.serializer(), record)
        PayoutEntity(
            id = row.id.lowercase(),
            // NOT lowercased: eBay's payout id is matched against
            // `sales.payout_reference` verbatim, and case-folding one side of a
            // join is how rows quietly stop matching.
            payoutId = row.payoutId,
            amountCents = row.amountCents,
            currency = row.currency,
            status = row.status,
            payoutDate = RealtimeRows.parseTimestamp(row.payoutDate),
            transactionCount = row.transactionCount,
            updatedAt = RealtimeRows.parseTimestamp(row.updatedAt) ?: 0L,
        )
    }.getOrNull()

    @Serializable
    private data class RemoteExpenseRow(
        val id: String,
        val category: String? = null,
        val description: String? = null,
        val amount: Double? = null,
        @SerialName("spent_on") val spentOn: String? = null,
        @SerialName("inventory_item_id") val inventoryItemId: String? = null,
        @SerialName("listing_id") val listingId: String? = null,
        @SerialName("created_at") val createdAt: String? = null,
    )

    fun decodeExpenseRow(record: JsonObject): ExpenseEntity? = runCatching {
        val row = json.decodeFromJsonElement(RemoteExpenseRow.serializer(), record)
        ExpenseEntity(
            id = row.id.lowercase(),
            category = row.category ?: "other",
            expenseDescription = row.description,
            amount = row.amount ?: 0.0,
            // spent_on is a DATE, not a timestamptz — parseTimestamp's
            // LocalDate branch is what handles it.
            spentOn = RealtimeRows.parseTimestamp(row.spentOn) ?: 0L,
            inventoryItemId = row.inventoryItemId?.lowercase(),
            listingId = row.listingId?.lowercase(),
            createdAt = RealtimeRows.parseTimestamp(row.createdAt) ?: 0L,
        )
    }.getOrNull()
}
