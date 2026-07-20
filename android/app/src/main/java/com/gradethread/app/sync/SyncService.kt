package com.gradethread.app.sync

import android.content.Context
import com.gradethread.app.platform.workspace.WorkspaceScope
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.ExpenseEntity
import com.gradethread.app.sync.db.ItemPhotoEntity
import com.gradethread.app.sync.db.ListingEntity
import com.gradethread.app.sync.db.SaleEntity
import com.gradethread.app.sync.db.SourceEntity
import dagger.hilt.android.qualifiers.ApplicationContext
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.postgrest.from
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

    /** Active workspace, else self — matching every other tenant-scoped read. */
    private fun ownerId(): String? =
        client.auth.currentUserOrNull()?.id?.let { WorkspaceScope.tenantOwnerId(it) }

    /**
     * @return null when signed out — there is no tenant to scope to, and an
     * unscoped pull would be a cross-tenant read.
     */
    suspend fun pull(): SyncCoordinator.Outcome? = withContext(Dispatchers.IO) {
        val owner = ownerId() ?: return@withContext null
        coordinator(owner).pullAll()
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
        @SerialName("listing_url") val listingUrl: String? = null,
        @SerialName("listing_price") val listingPrice: Double? = null,
        @SerialName("listing_status") val listingStatus: String? = null,
        @SerialName("listed_at") val listedAt: String? = null,
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
            platformOfferId = null,
            externalUrl = row.listingUrl,
            listingPrice = row.listingPrice ?: 0.0,
            listingStatus = row.listingStatus ?: "draft",
            listedAt = RealtimeRows.parseTimestamp(row.listedAt),
            endedAt = null,
            viewsTotal = row.views,
            watchersCount = row.watchers,
            // Provenance is set by the eBay sync path, not by a plain pull —
            // guessing an origin here would corrupt the source-of-truth model
            // (vault/20-domain/sync-source-of-truth.md).
            listingOrigin = null,
            publishError = null,
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
        @SerialName("buyer_username") val buyerUsername: String? = null,
        @SerialName("platform_order_id") val platformOrderId: String? = null,
        @SerialName("payout_reference") val payoutReference: String? = null,
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
            buyerUsername = row.buyerUsername,
            platformOrderId = row.platformOrderId,
            payoutReference = row.payoutReference,
            saleDate = RealtimeRows.parseTimestamp(row.saleDate) ?: 0L,
            soldAt = RealtimeRows.parseTimestamp(row.soldAt),
            shippedAt = RealtimeRows.parseTimestamp(row.shippedAt),
            trackingNumber = row.trackingNumber,
            createdAt = RealtimeRows.parseTimestamp(row.createdAt) ?: 0L,
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
