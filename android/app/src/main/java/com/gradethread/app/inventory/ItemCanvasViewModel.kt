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
import com.gradethread.app.marketplaces.ExtensionQueueKind
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
    /** US-2411: listing copy and aspect extraction. Both propose only. */
    private val listingAi: ListingCopyService,
    /** US-2413: fold specifics edits back into the item's own columns. */
    private val aspectWriteBack: AspectWriteBackService,
    // US-2481: queue a cross-list for the desktop extension from the phone.
    private val extensionQueue: com.gradethread.app.marketplaces.ExtensionQueueRepository,
    // US-2886: the "Sourced by" roster behind the picker.
    private val sourcers: SourcerRepository,
    /** US-2921: the expected-size band table behind the size check. */
    private val sizeBandsService: SizeBandsService,
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
        /**
         * US-2921: the expected-size band table for this item's brand and
         * garment. EMPTY means "nothing to say", which is also what a failed
         * fetch and a brand with no chart on file both look like.
         */
        val sizeBands: SizeCheck.BandsResponse = SizeCheck.BandsResponse.EMPTY,
        /**
         * US-2921: the size-versus-measurements note, waved off for this visit.
         * It is a check, not an error, so it has to be silenceable.
         */
        val sizeNoteDismissed: Boolean = false,
        /** US-1346: the eBay comps panel. */
        val comps: CompsState = CompsState.Idle,
        /** US-1347: the category's aspect spec. */
        val aspectSpec: AspectSpecState = AspectSpecState.Idle,
        /** US-2411: the AI's proposed title and description, before accepting. */
        val listingCopy: ListingCopy? = null,
        val writingCopy: Boolean = false,
        val listingCopyError: String? = null,
        /** US-2411: aspect extraction. */
        val fillingAspects: Boolean = false,
        val aspectAiError: String? = null,
        /**
         * How many specifics the last extraction actually filled. Null until
         * one has run; 0 is a real answer and says so.
         */
        val aspectsFilled: Int? = null,
        /**
         * US-2481: the platform whose cross-list is now waiting for the seller's
         * desktop browser. Null until they queue one.
         */
        val queuedForDesktop: String? = null,
        /**
         * Surfaced rather than swallowed — see queueForDesktop. A flag, not a
         * message: user-facing copy belongs in strings.xml where it can be
         * translated, not in a view model.
         */
        val queueFailed: Boolean = false,
        /**
         * US-1576: whether this item has a MeasureCard shot to measure from.
         *
         * The editor needs a photo whose `photo_type` is `measurement`; without
         * one there is nothing to calibrate against, so the entry point is
         * hidden rather than shown and then apologised for.
         */
        val hasMeasurementPhoto: Boolean = false,
        /** US-2886: the workspace roster the "Sourced by" picker offers. */
        val sourcerRoster: List<com.gradethread.app.sync.db.SourcerEntity> = emptyList(),
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
        specCategoryId = null
        _state.value = State(itemId = itemId)
        viewModelScope.launch {
            val item = db.items().byId(itemId)
            if (item == null) {
                _state.value = _state.value.copy(loading = false, notFound = true)
                return@launch
            }
            val draft = ItemDraft.from(item)
            _state.value = _state.value.copy(
                loading = false,
                original = draft,
                draft = draft,
                hasMeasurementPhoto = db.photos().forItem(itemId)
                    .any { it.photoType == MEASUREMENT_PHOTO_TYPE },
                // US-2886: the "Sourced by" roster, read from the synced cache
                // so the picker is populated before the next pull.
                sourcerRoster = runCatching { sourcers.roster() }.getOrDefault(emptyList()),
            )
        }
    }

    /**
     * US-2886: add a person to the roster and hand back the name to select.
     * `null` means nothing was written, and the picker says so rather than
     * selecting a name the server has never heard of.
     */
    fun addSourcer(name: String, onResult: (String?) -> Unit) {
        viewModelScope.launch {
            val saved = runCatching { sourcers.add(name) }.getOrNull()
            if (saved != null) {
                _state.value = _state.value.copy(
                    sourcerRoster = runCatching { sourcers.roster() }
                        .getOrDefault(_state.value.sourcerRoster),
                )
            }
            onResult(saved)
        }
    }

    /**
     * US-2481: queue this item's cross-list to run on the seller's desktop.
     *
     * The whole point of the queue is the case where the seller is sourcing in a
     * shop with only a phone: Poshmark, Mercari, Grailed, Vinted and Facebook
     * have no write API, so the listing has to be filled in a browser they do
     * not currently have open. The server stores WHAT to do and never a
     * marketplace credential.
     *
     * A failure is reported, not swallowed. A seller who believes they queued
     * something and did not will wait for a job that does not exist.
     */
    fun queueForDesktop(platform: String) {
        val itemId = _state.value.itemId ?: return
        viewModelScope.launch {
            val result = runCatching {
                extensionQueue.enqueue(
                    kind = ExtensionQueueKind.LIST,
                    platform = platform,
                    inventoryItemId = itemId,
                )
            }
            _state.value = if (result.isSuccess) {
                _state.value.copy(queuedForDesktop = platform, queueFailed = false)
            } else {
                _state.value.copy(queueFailed = true)
            }
        }
    }

    fun edit(transform: (ItemDraft) -> ItemDraft) {
        _state.value = _state.value.copy(
            draft = transform(_state.value.draft),
            errorMessage = null,
            queuedOffline = false,
        )
        // US-2494: a spec belongs to one category. Once the seller has asked
        // for the specifics, moving the item to another category leaves them
        // editing the wrong list, so re-fetch it (and re-run the free refill).
        // Untouched while the section is still Idle — nobody has asked yet.
        if (_state.value.aspectSpec !is AspectSpecState.Idle &&
            _state.value.draft.ebayCategoryId != specCategoryId
        ) {
            loadAspectSpec()
        }
    }

    fun setCategory(category: FlipdeskCategory?) = edit { it.copy(category = category) }

    /** US-1345: set or clear one measurement. A null value removes the key. */
    fun setMeasurement(key: String, value: Double?) = edit { draft ->
        val next = draft.measurements.toMutableMap()
        if (value == null || value <= 0.0) next.remove(key) else next[key] = value
        draft.copy(measurements = next)
    }

    /**
     * US-1576: take the overlay editor's numbers into the draft.
     *
     * Merged, not replaced. The editor only knows about the lines that were
     * drawn on the card photo, so a measurement the seller typed by hand for a
     * dimension they never drew has to survive — replacing the map would delete
     * it the first time anyone opened the editor.
     *
     * Values arrive already rounded to the quarter inch, and they overwrite:
     * a line on the photo is a measurement of the garment, which beats an
     * earlier typed guess at the same key.
     */
    fun applyMeasurements(values: Map<String, Double>) = edit { draft ->
        val next = draft.measurements.toMutableMap()
        for ((key, value) in values) {
            if (value > 0.0) next[key] = value else next.remove(key)
        }
        draft.copy(measurements = next)
    }

    /** US-1345: accept an AI size estimate into the size field. */
    fun applyInferredSize(size: String) {
        edit { it.copy(size = size) }
        dismissSizeEstimate()
    }

    // ── US-2921: size versus measurements ───────────────────────────────

    /** The last (brand, garment, department) a table was fetched for. */
    private var loadedSizeBandKey: String? = null

    /**
     * Load the band table when the brand, the garment or the department changes
     * — not on every keystroke in the size field, which is edited a character at
     * a time and would issue a request per character.
     */
    fun refreshSizeBands() {
        val draft = _state.value.draft
        val brand = draft.brand.trim().ifBlank { null }
        val garment = draft.garmentCategory.trim().ifBlank { null }
            ?: draft.category?.wire
        val department = SizeCheck.departmentFromText(
            listOf(draft.title, brand, draft.size, garment),
        )
        val key = listOf(brand, garment, department).joinToString("|") { it ?: "" }
        if (key == loadedSizeBandKey) return
        loadedSizeBandKey = key
        viewModelScope.launch {
            val table = sizeBandsService.load(brand, garment, department)
            // Drop a response that lost the race to a newer brand or garment.
            if (loadedSizeBandKey == key) {
                _state.value = _state.value.copy(sizeBands = table)
            }
        }
    }

    /** Does the size on the label agree with what this item measures? */
    fun sizeVerdict(): SizeCheck.Verdict {
        val state = _state.value
        val rows = state.sizeBands.rows
        return SizeCheck.check(
            rows = rows,
            rowIndex = SizeCheck.resolveRow(rows, state.draft.size),
            measurements = state.draft.measurements,
            tier = state.sizeBands.tier,
        )
    }

    /** US-2921: the one-click fix behind the size-versus-measurements note. */
    fun applyCheckedSize(size: String) {
        edit { it.copy(size = size) }
    }

    fun dismissSizeNote() {
        _state.value = _state.value.copy(sizeNoteDismissed = true)
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

    /**
     * The category the current [State.aspectSpec] belongs to, so a category
     * change can re-fetch and a response that lost the race can be dropped.
     */
    private var specCategoryId: String? = null

    fun loadAspectSpec() {
        val categoryId = _state.value.draft.ebayCategoryId
        if (_state.value.aspectSpec is AspectSpecState.Loading && categoryId == specCategoryId) {
            return
        }
        specCategoryId = categoryId
        _state.value = _state.value.copy(aspectSpec = AspectSpecState.Loading)
        viewModelScope.launch {
            val spec = aspectSpecs.fetch(categoryId)
            if (specCategoryId != categoryId) return@launch
            _state.value = _state.value.copy(aspectSpec = spec)
            // US-2494: the free refill runs the moment the spec is on screen,
            // so the seller sees the gaps the item's own data can answer before
            // they weigh spending an AI action on the vision fill below it.
            if (spec is AspectSpecState.Loaded) refillDerived(categoryId)
        }
    }

    /**
     * US-2494: re-derive the item-owned specifics. Free — no AI action, no row
     * written by the server.
     *
     * A failure is a silent no-op. This runs unprompted, on open and on a
     * category change, so an error toast would be noise about something the
     * seller never asked for; the manual fields and the AI fill both still
     * work.
     */
    private suspend fun refillDerived(categoryId: String?) {
        val itemId = _state.value.itemId ?: return
        val id = categoryId?.trim().orEmpty()
        if (id.isEmpty()) return
        val before = _state.value.draft
        val result = runCatching {
            aspectSpecs.derive(
                itemId = itemId,
                categoryId = id,
                knownAspects = AspectSync.preserved(before.aspects, before.aspectSources),
            )
        }.getOrNull() ?: return
        if (specCategoryId != categoryId) return

        val draft = _state.value.draft
        val reconciled = AspectSync.reconcileDerived(
            draft.aspects,
            draft.aspectSources,
            result.derived,
            result.validAspectNames,
        )
        val owned = AspectSync.applyColumnAuthority(
            reconciled.first,
            reconciled.second,
            result.derived,
            result.columnOwned,
            result.columnCleared,
        )
        // The server derived from the PERSISTED row, so its five column-owned
        // values are one save behind anything the seller is typing right now.
        // Re-projecting the draft's own columns last is what stops the two
        // projections from disagreeing on screen; it is also exactly what the
        // save path does, so nothing here can be undone by pressing Save.
        val (aspects, sources) = AspectSync.projectColumnAspects(draft, owned.first, owned.second)
        if (aspects == draft.aspects && sources == draft.aspectSources) return
        _state.value = _state.value.copy(
            draft = draft.copy(aspects = aspects, aspectSources = sources),
        )
    }

    // ── US-2411: the two AI proposals ────────────────────────────────────

    /**
     * Ask the model to write the listing copy. One AI action.
     *
     * The answer lands in [State.listingCopy] and NOWHERE else until the
     * seller accepts it. Overwriting a description they had already written,
     * on a screen where the undo is retyping it, is not a trade worth making
     * for one fewer tap.
     */
    fun writeListingCopy() {
        val itemId = _state.value.itemId ?: return
        if (_state.value.writingCopy) return
        _state.value = _state.value.copy(writingCopy = true, listingCopyError = null)
        viewModelScope.launch {
            runCatching { listingAi.listingCopy(itemId) }
                .onSuccess { _state.value = _state.value.copy(listingCopy = it) }
                .onFailure {
                    _state.value = _state.value.copy(
                        listingCopyError = ListingCopyService.message(it),
                    )
                }
            _state.value = _state.value.copy(writingCopy = false)
        }
    }

    /**
     * Take the proposed copy into the draft.
     *
     * A blank field is not applied. An empty title is the model saying it had
     * nothing, and writing that over real copy would be a silent deletion.
     */
    fun applyListingCopy() {
        val copy = _state.value.listingCopy ?: return
        edit { draft ->
            draft.copy(
                title = copy.title.ifBlank { draft.title },
                description = copy.description.ifBlank { draft.description },
            )
        }
        dismissListingCopy()
    }

    fun dismissListingCopy() {
        _state.value = _state.value.copy(listingCopy = null, listingCopyError = null)
    }

    /**
     * Propose item specifics from the photos. One AI action.
     *
     * The values land in the DRAFT, marked [AspectSync.Provenance.AI_EXTRACTED],
     * and the seller still has to press Save — which is the accept. Only EMPTY
     * specifics are filled: a value they typed is theirs, and a model that
     * disagreed with it would otherwise quietly win.
     */
    fun fillAspectsFromPhotos() {
        val itemId = _state.value.itemId ?: return
        if (_state.value.fillingAspects) return
        _state.value = _state.value.copy(
            fillingAspects = true,
            aspectAiError = null,
            aspectsFilled = null,
        )
        viewModelScope.launch {
            runCatching {
                listingAi.extractAspects(
                    itemId = itemId,
                    categoryId = _state.value.draft.ebayCategoryId,
                    knownAspects = _state.value.draft.aspects,
                )
            }
                .onSuccess { result ->
                    val filled = AspectSync.fillFromAi(
                        _state.value.draft.aspects,
                        _state.value.draft.aspectSources,
                        result.suggestions.mapValues { it.value.values },
                    )
                    edit { it.copy(aspects = filled.first, aspectSources = filled.second) }
                    _state.value = _state.value.copy(aspectsFilled = filled.third)
                }
                .onFailure {
                    _state.value = _state.value.copy(
                        aspectAiError = ListingCopyService.message(it),
                    )
                }
            _state.value = _state.value.copy(fillingAspects = false)
        }
    }

    fun dismissAspectAi() {
        _state.value = _state.value.copy(aspectAiError = null, aspectsFilled = null)
    }

    /** A manual edit from the specifics editor — outranks derivation. */
    fun setAspect(name: String, values: List<String>) = edit { draft ->
        val (aspects, sources) = AspectSync.setManual(
            draft.aspects,
            draft.aspectSources,
            name,
            values,
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
        if (index !in draft.comps.indices) {
            draft
        } else {
            draft.copy(comps = draft.comps.filterIndexed { i, _ -> i != index })
        }
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
                // US-2413: only after the row itself landed. The write-back
                // reads that row to decide what to change, so running it first
                // would fold the edits into a version of the item the server
                // has not seen.
                val queued = writeBackAspects(itemId, current)
                // US-2341: the server now holds this edit, so stop defending the
                // local copy. applyLocally stamps hasLocalChanges = true on every
                // edit, and the ONLY place it was ever cleared is
                // MutationReplayer.mirrorLocally - which runs on the offline
                // REPLAY path. An online save therefore never cleared it, so the
                // canvas kept reporting unsaved changes and the sync engine's
                // conflict policy kept defending a row with nothing left to
                // defend.
                //
                // Left SET when the aspect write-back queued: that half really
                // has not reached the server yet, and this flag is what makes
                // the next pull treat the local copy as the newer one.
                //
                // Re-read rather than reusing the pre-save copy, mirroring
                // mirrorLocally - a concurrent edit between the write and here
                // would otherwise be clobbered by a stale row.
                if (!queued) {
                    runCatching {
                        db.items().byId(itemId)?.let {
                            db.items().upsert(listOf(it.copy(hasLocalChanges = false)))
                        }
                    }
                }
                _state.value = _state.value.copy(
                    saving = false,
                    original = _state.value.draft,
                    savedAtLeastOnce = true,
                    // The item is not claimed as fully synced while a
                    // write-back is still waiting in the queue.
                    queuedOffline = queued,
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

    /**
     * US-2413: fold the specifics into the item's own columns.
     *
     * Returns true when the call did not land and was queued instead, so the
     * canvas can keep saying "waiting to sync" rather than claiming a row is
     * finished while Brand still has not reached its column.
     *
     * Skipped entirely when the specifics did not change: the endpoint is a
     * write, and re-asserting an unchanged map on every price edit is a round
     * trip and an audit row for nothing.
     */
    private suspend fun writeBackAspects(itemId: String, before: State): Boolean {
        val draft = _state.value.draft
        if (draft.aspects == before.original.aspects &&
            draft.aspectSources == before.original.aspectSources
        ) {
            return false
        }
        val result = runCatching {
            aspectWriteBack.writeBack(itemId, draft.aspects, draft.aspectSources)
        }
        val error = result.exceptionOrNull() ?: return false
        if (!OfflineMutationQueue.shouldEnqueue(error)) {
            // A refusal the server means (a 4xx) will not become true on a
            // retry, so queueing it would only fill the inspector.
            return false
        }
        queue.enqueue(
            kind = MutationKind.EBAY_ASPECT_WRITE_BACK,
            targetId = itemId,
            payload = AspectWriteBackService
                .payload(itemId, draft.aspects, draft.aspectSources)
                .toString()
                .toByteArray(),
        )
        return true
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
            draft,
            draft.aspects,
            draft.aspectSources,
        ).let { (aspects, sources) ->
            AspectSync.encodeSources(AspectSync.pruneSources(sources, aspects))
        },
        updatedAt = System.currentTimeMillis(),
        hasLocalChanges = true,
    )

    private fun ownerId(): String? = client.auth.currentUserOrNull()?.id?.let { WorkspaceScope.tenantOwnerId(it) }

    private fun patchPayload(itemId: String, patch: JsonObject): ByteArray =
        """{"id":"$itemId","patch":$patch}""".encodeToByteArray()

    private fun message(error: Throwable): String = (error as? EdgeApiError)?.userMessage()
        ?: error.message
        ?: "Couldn't save those changes."

    private companion object {
        const val TABLE = "inventory_items"
        const val MEASUREMENT_PHOTO_TYPE = "measurement"
    }
}
