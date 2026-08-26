package com.gradethread.app.inventory

import com.gradethread.app.capture.DetailsIntakeState
import com.gradethread.app.platform.workspace.WorkspaceScope
import com.gradethread.app.sync.MutationKind
import com.gradethread.app.sync.OfflineMutationQueue
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.SourceEntity
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.postgrest.from
import kotlinx.serialization.json.Json
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-1330: the IO half of details intake. All decisions live in
 * [IntakeSubmission]; this only supplies the seams (lookup / insert / patch /
 * enqueue) and the tenant scoping.
 */
@Singleton
class IntakeRepository @Inject constructor(
    private val client: SupabaseClient,
    private val db: GradeThreadDb,
    private val queue: OfflineMutationQueue,
) {

    /** The tenant every query is scoped to: active workspace, else self. */
    private fun ownerId(): String? = client.auth.currentUserOrNull()?.id?.let { WorkspaceScope.tenantOwnerId(it) }

    /** Local sources feed the picker; archived ones are filtered by the caller. */
    suspend fun sources(): List<SourceEntity> = db.sources().all()

    suspend fun submit(state: DetailsIntakeState): IntakeSubmission.Outcome {
        val owner = ownerId()
            ?: return IntakeSubmission.Outcome.Failed(IllegalStateException("Not signed in"))
        return IntakeSubmission.submit(
            state = state,
            ownerId = owner,
            itemId = UUID.randomUUID().toString().lowercase(),
            findBySku = { sku -> findBySku(sku, owner) },
            insert = { payload -> client.from(TABLE).insert(payload) },
            shouldQueue = { OfflineMutationQueue.shouldEnqueue(it) },
            enqueue = { id, payload ->
                queue.enqueue(
                    kind = MutationKind.CREATE_INVENTORY_ITEM,
                    targetId = id,
                    payload = payload.toString().encodeToByteArray(),
                )
            },
        )
    }

    /**
     * Apply the user's merge choices to the row that already owns the SKU.
     * A plain scoped UPDATE — no `merge_inventory_items` RPC, because intake
     * never inserted a survivor row whose children would need re-pointing.
     */
    suspend fun applyMerge(
        state: DetailsIntakeState,
        existing: IntakeSubmission.ExistingItem,
        keepExisting: Set<ItemMergePlan.Field>,
    ): Result<String> = runCatching {
        val owner = ownerId() ?: error("Not signed in")
        val patch = IntakeSubmission.mergePatch(state, existing, keepExisting)
        if (patch.isNotEmpty()) {
            client.from(TABLE).update(patch) {
                filter {
                    eq("id", existing.id)
                    // Tenant-scoped: never act on an id alone.
                    eq("user_id", owner)
                }
            }
        }
        existing.id
    }

    private suspend fun findBySku(sku: String, owner: String): IntakeSubmission.ExistingItem? {
        val rows = client.from(TABLE).select {
            filter {
                eq("user_id", owner)
                eq("sku", sku)
            }
            limit(1)
        }.decodeList<SkuOwnerRow>()
        return rows.firstOrNull()?.toExisting()
    }

    private companion object {
        const val TABLE = "inventory_items"
        val json = Json { ignoreUnknownKeys = true }
    }
}

/**
 * Only the columns the merge sheet reconciles — a narrow projection so an
 * unrelated schema addition can't break intake decoding.
 */
@kotlinx.serialization.Serializable
private data class SkuOwnerRow(
    val id: String,
    val title: String? = null,
    val brand: String? = null,
    val style: String? = null,
    val size: String? = null,
    val color: String? = null,
    val material: String? = null,
    @kotlinx.serialization.SerialName("item_category") val itemCategory: String? = null,
    val status: String? = null,
    val container: String? = null,
    @kotlinx.serialization.SerialName("sourced_by") val sourcedBy: String? = null,
    @kotlinx.serialization.SerialName("acquired_date") val acquiredDate: String? = null,
    @kotlinx.serialization.SerialName("acquired_price") val acquiredPrice: String? = null,
    val description: String? = null,
) {
    fun toExisting() = IntakeSubmission.ExistingItem(
        id = id, title = title, brand = brand, style = style, size = size,
        color = color, material = material, itemCategory = itemCategory,
        status = status, container = container, sourcedBy = sourcedBy,
        acquiredDate = acquiredDate, acquiredPrice = acquiredPrice,
        description = description,
    )
}
