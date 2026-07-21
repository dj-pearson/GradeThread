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
    private val sizeAi: SizeAiService,
    private val compsService: CompsService,
    private val aspectSpecs: AspectSpecService,
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
        /** US-1345: the AI size suggestion, once asked for. */
        val sizeEstimate: SizeEstimate? = null,
        val estimatingSize: Boolean = false,
        val sizeErrorMessage: String? = null,
        /** US-1346: the eBay comps panel. */
        val comps: CompsState = CompsState.Idle,
        /** US-1347: the category's aspect spec. */
        val aspectSpec: AspectSpecState = AspectSpecState.Idle,
    ) {
        /** Required specifics with no value — the publish blockers. */
        val missingRequiredAspects: List<String>
            get() = (aspectSpec as? AspectSpecState.Loaded)?.let { loaded ->
                AspectSync.requiredMissing(
                    AspectSpecs.requiredNames(loaded.aspects),
                    // Against the PROJECTED map, so a Brand typed in the
                    // identity section already counts as filled.
                    AspectSync.projectColumnAspects(draft, draft.aspects, draft.aspectSources).first,
                )
            }.orEmpty()

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

    /** US-1345: set or clear one measurement. A null value removes the key. */
    fun setMeasurement(key: String, value: Double?) = edit { draft ->
        val next = draft.measurements.toMutableMap()
        if (value == null || value <= 0.0) next.remove(key) else next[key] = value
        draft.copy(measurements = next)
    }

    /** US-1345: accept an AI size estimate into the size field. */
    fun applyInferredSize(size: String) {
        edit { it.copy(size = size) }
        dismissSizeEstimate()
    }

    fun estimateSize() {
        val itemId = _state.value.itemId ?: return
        if (_state.value.estimatingSize) return
        _state.value = _state.value.copy(estimatingSize = true, sizeErrorMessage = null)
        viewModelScope.launch {
            runCatching { sizeAi.estimate(itemId) }
                .onSuccess { estimate ->
                    _state.value = _state.value.copy(
                        estimatingSize = false,
                        sizeEstimate = estimate,
                    )
                }
                .onFailure { error ->
                    _state.value = _state.value.copy(
                        estimatingSize = false,
                        sizeErrorMessage = message(error),
                    )
                }
        }
    }

    // ── US-1347: aspects ─────────────────────────────────────────────────

    fun loadAspectSpec() {
        if (_state.value.aspectSpec is AspectSpecState.Loading) return
        _state.value = _state.value.copy(aspectSpec = AspectSpecState.Loading)
        viewModelScope.launch {
            _state.value = _state.value.copy(
                aspectSpec = aspectSpecs.fetch(_state.value.draft.ebayCategoryId),
            )
        }
    }

    /** A manual edit from the specifics editor — outranks derivation. */
    fun setAspect(name: String, values: List<String>) = edit { draft ->
        val (aspects, sources) = AspectSync.setManual(
            draft.aspects, draft.aspectSources, name, values,
        )
        draft.copy(aspects = aspects, aspectSources = sources)
    }

    // ── US-1346: comps ───────────────────────────────────────────────────

    fun fetchComps() {
        val draft = _state.value.draft
        if (_state.value.comps is CompsState.Loading) return
        _state.value = _state.value.copy(comps = CompsState.Loading)
        viewModelScope.launch {
            val result = compsService.lookup(draft.title, draft.brand, draft.size)
            _state.value = _state.value.copy(comps = result)
            // The comps hop already resolved a leaf category; adopting it here
            // is what gives the specifics editor something to fetch, instead of
            // making the seller resolve the same category twice.
            if (result is CompsState.Loaded && _state.value.draft.ebayCategoryId.isNullOrBlank()) {
                edit { it.copy(ebayCategoryId = result.lookup.categoryId) }
            }
        }
    }

    /** One-tap "use median" — into TARGET price, never the acquired cost. */
    fun useMedian(median: Double) = edit {
        it.copy(targetPriceText = CurrencyAmount.formatRaw(Math.round(median * 100)))
    }

    fun addComp(comp: ItemComp) = edit { it.copy(comps = it.comps + comp) }

    fun removeComp(index: Int) = edit { draft ->
        if (index !in draft.comps.indices) draft
        else draft.copy(comps = draft.comps.filterIndexed { i, _ -> i != index })
    }

    fun dismissSizeEstimate() {
        _state.value = _state.value.copy(sizeEstimate = null, sizeErrorMessage = null)
    }

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
        measurementsJson = MeasurementCatalog.encode(draft.measurements),
        compSetJson = CompSet.encode(draft.comps),
        ebayCategoryId = draft.ebayCategoryId,
        ebayAspectsJson = AspectSync.projectColumnAspects(draft, draft.aspects, draft.aspectSources)
            .let { (aspects, _) -> AspectSync.encodeAspects(aspects) },
        ebayAspectSourcesJson = AspectSync.projectColumnAspects(
            draft, draft.aspects, draft.aspectSources,
        ).let { (aspects, sources) ->
            AspectSync.encodeSources(AspectSync.pruneSources(sources, aspects))
        },
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
