package com.gradethread.app.inventory

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.capture.CurrencyAmount
import com.gradethread.app.capture.FlipdeskCategory
import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.platform.workspace.WorkspaceScope
import com.gradethread.app.sync.MutationKind
import com.gradethread.app.sync.OfflineMutationQueue
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.InventoryItemEntity
import dagger.hilt.android.lifecycle.HiltViewModel
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.postgrest.from
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import javax.inject.Inject

/**
 * US-1343: the item canvas.
 *
 * Writes OPTIMISTICALLY — Room first, so the field the seller just edited stops
 * looking unsaved immediately — and rolls the row back if the server refuses.
 * Offline, the change is kept and queued rather than rolled back: it isn't
 * wrong, it just hasn't landed.
 */
@HiltViewModel
class ItemCanvasViewModel @Inject constructor(
    private val db: GradeThreadDb,
    private val client: SupabaseClient,
    private val queue: OfflineMutationQueue,
) : ViewModel() {

    data class State(
        val itemId: String? = null,
        val loading: Boolean = true,
        /** The row as it was when the canvas opened — the diff baseline. */
        val original: ItemDraft = ItemDraft(),
        val draft: ItemDraft = ItemDraft(),
        val saving: Boolean = false,
        val savedAtLeastOnce: Boolean = false,
        val errorMessage: String? = null,
        /** Set when the edit was kept locally and queued for replay. */
        val queuedOffline: Boolean = false,
        val notFound: Boolean = false,
    ) {
        val isDirty: Boolean get() = ItemPatch.isDirty(original, draft)

        /** A blank title can't be saved: the column is NOT NULL. */
        val canSave: Boolean get() = isDirty && !saving && draft.title.isNotBlank()
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun bind(itemId: String) {
        if (_state.value.itemId == itemId) return
        _state.value = State(itemId = itemId)
        viewModelScope.launch {
            val item = db.items().byId(itemId)
            if (item == null) {
                _state.value = _state.value.copy(loading = false, notFound = true)
                return@launch
            }
            val draft = ItemDraft.from(item)
            _state.value = _state.value.copy(loading = false, original = draft, draft = draft)
        }
    }

    fun edit(transform: (ItemDraft) -> ItemDraft) {
        _state.value = _state.value.copy(
            draft = transform(_state.value.draft),
            errorMessage = null,
            queuedOffline = false,
        )
    }

    fun setCategory(category: FlipdeskCategory?) = edit { it.copy(category = category) }

    fun save() {
        val current = _state.value
        val itemId = current.itemId ?: return
        if (!current.canSave) return

        val patch = ItemPatch.diff(current.original, current.draft)
        if (patch.isEmpty()) return

        _state.value = current.copy(saving = true, errorMessage = null, queuedOffline = false)

        viewModelScope.launch {
            val before = db.items().byId(itemId)
            // Optimistic: Room first, so the canvas stops showing unsaved
            // edits the moment the seller taps save.
            before?.let { db.items().upsert(listOf(applyLocally(it, current.draft))) }

            val owner = ownerId()
            if (owner == null) {
                rollback(before, "You're signed out — sign in again to save this.")
                return@launch
            }

            runCatching {
                client.from(TABLE).update(patch) {
                    filter {
                        eq("id", itemId)
                        // Tenant scope. Never act on an id alone.
                        eq("user_id", owner)
                    }
                }
            }.onSuccess {
                _state.value = _state.value.copy(
                    saving = false,
                    original = _state.value.draft,
                    savedAtLeastOnce = true,
                )
            }.onFailure { error ->
                if (OfflineMutationQueue.shouldEnqueue(error)) {
                    // NOT a rollback. The edit is correct, it just hasn't
                    // reached the server; discarding the seller's typing
                    // because the train went into a tunnel would be the
                    // worse outcome.
                    queue.enqueue(
                        kind = MutationKind.UPDATE_INVENTORY_ITEM,
                        targetId = itemId,
                        payload = patchPayload(itemId, patch),
                    )
                    _state.value = _state.value.copy(
                        saving = false,
                        original = _state.value.draft,
                        savedAtLeastOnce = true,
                        queuedOffline = true,
                    )
                } else {
                    rollback(before, message(error))
                }
            }
        }
    }

    /** Put the local row back the way it was, and say why. */
    private suspend fun rollback(before: InventoryItemEntity?, message: String) {
        before?.let { db.items().upsert(listOf(it)) }
        _state.value = _state.value.copy(
            saving = false,
            // The seller's edits stay in the draft so they can retry rather
            // than retype; only the persisted row reverts.
            errorMessage = message,
        )
    }

    fun discard() {
        _state.value = _state.value.copy(
            draft = _state.value.original,
            errorMessage = null,
            queuedOffline = false,
        )
    }

    fun dismissError() {
        _state.value = _state.value.copy(errorMessage = null)
    }

    /**
     * The local mirror of the patch.
     *
     * `hasLocalChanges` is set so the sync engine's conflict policy defends
     * this row until the write is confirmed — without it, a pull landing
     * mid-flight would overwrite the edit with the server's older copy.
     */
    private fun applyLocally(item: InventoryItemEntity, draft: ItemDraft) = item.copy(
        title = draft.title.trim(),
        brand = draft.brand.trim().ifBlank { null },
        sku = draft.sku.trim().ifBlank { null },
        size = draft.size.trim().ifBlank { null },
        color = draft.color.trim().ifBlank { null },
        material = draft.material.trim().ifBlank { null },
        style = draft.style.trim().ifBlank { null },
        status = draft.status,
        itemCategory = draft.category?.wire,
        garmentType = draft.garmentType.trim().ifBlank { null },
        garmentCategory = draft.garmentCategory.trim().ifBlank { null },
        itemDescription = draft.description.trim().ifBlank { null },
        conditionNotes = draft.conditionNotes.trim().ifBlank { null },
        sourcedBy = draft.sourcedBy.trim().ifBlank { null },
        container = draft.container.trim().ifBlank { null },
        locationBin = draft.locationBin.trim().ifBlank { null },
        acquiredDate = draft.acquiredDate,
        acquiredPrice = CurrencyAmount.parseCents(draft.acquiredPriceText)?.let { it / 100.0 },
        targetPrice = CurrencyAmount.parseCents(draft.targetPriceText)?.let { it / 100.0 },
        consignorId = draft.consignorId?.takeIf { it.isNotBlank() },
        consignmentSplitPct = CurrencyAmount.parseCents(draft.consignmentSplitText)
            ?.let { it / 100.0 },
        updatedAt = System.currentTimeMillis(),
        hasLocalChanges = true,
    )

    private fun ownerId(): String? =
        client.auth.currentUserOrNull()?.id?.let { WorkspaceScope.tenantOwnerId(it) }

    private fun patchPayload(itemId: String, patch: JsonObject): ByteArray =
        """{"id":"$itemId","patch":$patch}""".encodeToByteArray()

    private fun message(error: Throwable): String =
        (error as? EdgeApiError)?.userMessage()
            ?: error.message
            ?: "Couldn't save those changes."

    private companion object {
        const val TABLE = "inventory_items"
    }
}
