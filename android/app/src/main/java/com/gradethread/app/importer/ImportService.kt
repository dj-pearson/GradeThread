package com.gradethread.app.importer

import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.MutationKind
import com.gradethread.app.sync.OfflineMutationQueue
import com.gradethread.app.platform.workspace.WorkspaceScope
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.query.Columns
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.util.UUID
import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-1389: reading the seller's existing SKUs and writing the imported rows.
 *
 * Through the ANON client, exactly like manual intake, so RLS applies and rows
 * land under the right tenant. Nothing here uses a service-role path.
 */
interface ImportCommitting {
    suspend fun existingSkus(): Set<String>

    suspend fun commit(drafts: List<ImportDraft>): CommitResult
}

/**
 * What a commit did.
 *
 * [queued] is not a failure: the row is in the offline mutation queue and will
 * replay on reconnect. Reporting it as failed would send a seller off to redo a
 * migration that is already going to land.
 */
data class CommitResult(val queued: List<Int> = emptyList(), val failures: List<ImportRejection> = emptyList())

@Singleton
class ImportService @Inject constructor(private val client: SupabaseClient, private val queue: OfflineMutationQueue) :
    ImportCommitting {

    override suspend fun existingSkus(): Set<String> {
        val ownerId = ownerId() ?: return emptySet()
        return runCatching {
            client.from(TABLE).select(Columns.raw("sku")) {
                filter { eq("user_id", ownerId) }
            }.decodeList<SkuRow>()
                .mapNotNull { it.sku?.trim()?.takeIf { s -> s.isNotEmpty() }?.lowercase() }
                .toSet()
        }.getOrElse {
            Telemetry.breadcrumb("import sku preload failed: ${it.message}", "import")
            // An empty set means "we don't know", which lets the import proceed
            // and lets the database's own uniqueness be the backstop. Blocking
            // the whole migration because one read failed is the worse trade.
            emptySet()
        }
    }

    /**
     * Insert row by row.
     *
     * Deliberately NOT one bulk insert: a single bad row would fail the whole
     * batch, and a seller migrating 400 items would get nothing and no idea
     * which line was at fault. One request per row is slower and worth it.
     */
    override suspend fun commit(drafts: List<ImportDraft>): CommitResult {
        val ownerId = ownerId() ?: return CommitResult(
            failures = drafts.map {
                ImportRejection(it.sheetRow, UiMessage(R.string.import_error_signed_out))
            },
        )
        val queued = mutableListOf<Int>()
        val failures = mutableListOf<ImportRejection>()

        drafts.forEach { draft ->
            val itemId = UUID.randomUUID().toString().lowercase()
            val payload = draft.toInsert(ownerId, itemId)
            runCatching { client.from(TABLE).insert(payload) }.onFailure { error ->
                // Offline is not a failure — the same insert-then-queue path
                // manual capture uses (CapturePublisher). A migration started
                // on a train should finish itself when the signal comes back.
                if (OfflineMutationQueue.shouldEnqueue(error)) {
                    queue.enqueue(
                        kind = MutationKind.CREATE_INVENTORY_ITEM,
                        targetId = itemId,
                        payload = json.encodeToString(ItemInsert.serializer(), payload)
                            .encodeToByteArray(),
                    )
                    queued += draft.sheetRow
                } else {
                    failures += ImportRejection(
                        draft.sheetRow,
                        // The server's own sentence when there is one - on a
                        // 400-row migration it is usually the only thing that
                        // says WHICH column the database rejected.
                        UiMessage(
                            R.string.import_error_row_not_saved,
                            detail = error.message?.take(ERROR_DETAIL_CHARS),
                        ),
                    )
                }
            }
        }
        Telemetry.event(
            "inventory_imported",
            mapOf("rows" to drafts.size, "queued" to queued.size, "failed" to failures.size),
        )
        return CommitResult(queued, failures)
    }

    /** The active workspace, else the signed-in user — the standard scoping. */
    private fun ownerId(): String? = client.auth.currentUserOrNull()?.id?.let { WorkspaceScope.tenantOwnerId(it) }

    companion object {
        const val TABLE = "inventory_items"

        /** Enough of a database error to identify the column, not the stack. */
        const val ERROR_DETAIL_CHARS = 120
        private val json = Json { encodeDefaults = true }
    }

    @Serializable
    private data class SkuRow(val sku: String? = null)
}

/**
 * The insert payload.
 *
 * Nulls are ENCODED, not omitted, so a blank spreadsheet cell explicitly clears
 * rather than leaving a column at whatever a default would set. `status` is
 * never null — the plan already defaulted it.
 */
@Serializable
internal data class ItemInsert(
    val id: String,
    @SerialName("user_id") val userId: String,
    val title: String,
    val sku: String? = null,
    val brand: String? = null,
    val style: String? = null,
    val size: String? = null,
    val color: String? = null,
    val material: String? = null,
    @SerialName("item_category") val itemCategory: String? = null,
    val status: String,
    @SerialName("acquired_price") val acquiredPrice: Double? = null,
    @SerialName("target_price") val targetPrice: Double? = null,
    @SerialName("acquired_date") val acquiredDate: String? = null,
    val description: String? = null,
)

/**
 * The id is minted CLIENT-SIDE and lowercased.
 *
 * The offline queue replays the payload verbatim and needs an id to key on, and
 * every client-minted UUID in this app is lowercased because Postgres
 * normalizes them — case-mismatched ids caused duplicate-item sync bugs on iOS.
 */
private fun ImportDraft.toInsert(ownerId: String, itemId: String) = ItemInsert(
    id = itemId,
    userId = ownerId,
    title = title,
    sku = sku,
    brand = brand,
    style = style,
    size = size,
    color = color,
    material = material,
    itemCategory = itemCategory,
    status = status ?: Importer.DEFAULT_STATUS,
    acquiredPrice = acquiredPrice,
    targetPrice = targetPrice,
    acquiredDate = acquiredDate,
    description = conditionNotes,
)
