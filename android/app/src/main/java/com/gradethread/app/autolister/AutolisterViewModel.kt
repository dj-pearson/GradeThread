package com.gradethread.app.autolister

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.SyncService
import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1359: batch generation, photo QA, and the drafts they produce.
 */
@HiltViewModel
class AutolisterViewModel @Inject constructor(
    private val service: AutolisterService,
    private val drafts: DraftsService,
    private val sync: SyncService,
) : ViewModel() {

    data class State(
        val loading: Boolean = false,
        val batch: AutolisterBatch? = null,
        val jobs: List<AutolisterJob> = emptyList(),
        /** When the batch's counts last moved — the stall check reads this. */
        val lastProgressMs: Long = 0,
        val stalled: Boolean = false,
        val qaResults: List<PhotoQaResult> = emptyList(),
        val runningQa: Boolean = false,
        val drafts: List<DraftListing> = emptyList(),
        val selected: Set<String> = emptySet(),
        val busy: Boolean = false,
        val banner: UiMessage? = null,
        val errorMessage: UiMessage? = null,
        /** US-2408: the per-platform drafts for one item, once asked for. */
        val platformFields: PlatformFieldsResponse? = null,
        val loadingPlatformFields: Boolean = false,
    ) {
        val failedJobs: List<AutolisterJob> get() = Autolister.failedJobs(jobs)
        val canRetry: Boolean get() = batch?.let { Autolister.canRetryFailed(it) } == true
        val allSelected: Boolean
            get() = drafts.isNotEmpty() && selected.size == drafts.size
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    private var pollJob: Job? = null

    fun loadDrafts() {
        _state.value = _state.value.copy(loading = true, errorMessage = null)
        viewModelScope.launch {
            runCatching { drafts.drafts() }
                .onSuccess { rows ->
                    _state.value = _state.value.copy(
                        drafts = rows,
                        loading = false,
                        selected = _state.value.selected.intersect(rows.map { it.id }.toSet()),
                    )
                }
                .onFailure {
                    _state.value = _state.value.copy(
                        loading = false,
                        errorMessage = UiMessage(R.string.autolister_drafts_load_failed),
                    )
                }
        }
    }

    // ── batches ──────────────────────────────────────────────────────────────

    fun startBatch(itemIds: List<String>) {
        if (itemIds.isEmpty() || _state.value.busy) return
        _state.value = _state.value.copy(busy = true, errorMessage = null, banner = null)
        viewModelScope.launch {
            runCatching { service.startBatch(itemIds) }
                .onSuccess {
                    Telemetry.event("autolister_batch_started", mapOf("items" to it.itemCount))
                    _state.value = _state.value.copy(
                        busy = false,
                        banner = UiMessage(
                            R.string.autolister_batch_started,
                            args = listOf(it.itemCount),
                        ),
                    )
                    watch(it.batchId)
                }
                .onFailure {
                    _state.value = _state.value.copy(
                        busy = false,
                        errorMessage = service.message(it),
                    )
                }
        }
    }

    /**
     * Poll a batch until it finishes.
     *
     * The batch runs server-side whether or not this screen is open, so polling
     * is only about display. It stops on a terminal status rather than a
     * deadline — and separately notices when the counts have stopped moving, so
     * a dead worker surfaces as a stall instead of an eternal spinner.
     */
    fun watch(batchId: String) {
        pollJob?.cancel()
        pollJob = viewModelScope.launch {
            var lastDone = -1
            _state.value = _state.value.copy(lastProgressMs = System.currentTimeMillis())
            while (true) {
                val response = runCatching { service.batch(batchId) }.getOrNull()
                if (response != null) {
                    val done = Autolister.done(response.batch)
                    val now = System.currentTimeMillis()
                    val moved = done != lastDone
                    if (moved) lastDone = done
                    val lastProgress =
                        if (moved) now else _state.value.lastProgressMs
                    _state.value = _state.value.copy(
                        batch = response.batch,
                        jobs = response.jobs,
                        lastProgressMs = lastProgress,
                        stalled = Autolister.isStalled(response.batch, lastProgress, now),
                    )
                    if (response.batch.status.isTerminal) {
                        // The drafts exist now; the item statuses moved too.
                        loadDrafts()
                        sync.pull()
                        return@launch
                    }
                }
                delay(Autolister.POLL_INTERVAL_MS)
            }
        }
    }

    fun retryFailed() {
        val batchId = _state.value.batch?.id ?: return
        act(UiMessage(R.string.autolister_retrying)) {
            val result = service.retryFailed(batchId)
            if (result.retried > 0) watch(batchId)
        }
    }

    /** Nudge a stalled batch. Safe to repeat — the server re-dispatches open jobs. */
    fun resume() {
        val batchId = _state.value.batch?.id ?: return
        act(UiMessage(R.string.autolister_resumed)) {
            service.resume(batchId)
            watch(batchId)
        }
    }

    // ── photo QA ─────────────────────────────────────────────────────────────

    /**
     * Score photos before generating.
     *
     * Worth doing first: generation costs AI quota per item, and a cover shot
     * that QA would reject produces a draft nobody can publish.
     */
    fun runPhotoQa(itemIds: List<String>) {
        if (itemIds.isEmpty() || _state.value.runningQa) return
        _state.value = _state.value.copy(runningQa = true, errorMessage = null)
        viewModelScope.launch {
            runCatching { service.photoQa(itemIds) }
                .onSuccess {
                    _state.value = _state.value.copy(
                        runningQa = false,
                        qaResults = it.results,
                        banner = qaBanner(it.results),
                    )
                }
                .onFailure {
                    _state.value = _state.value.copy(
                        runningQa = false,
                        errorMessage = service.message(it),
                    )
                }
        }
    }

    private fun qaBanner(results: List<PhotoQaResult>): UiMessage {
        val attention = Autolister.needsAttention(results).size
        return if (attention == 0) {
            UiMessage(R.string.autolister_qa_all_good, args = listOf(results.size))
        } else {
            UiMessage(
                R.string.autolister_qa_some_need,
                args = listOf(attention, results.size),
            )
        }
    }

    // ── drafts ───────────────────────────────────────────────────────────────

    fun toggle(draftId: String) {
        val next = _state.value.selected.toMutableSet()
        if (!next.add(draftId)) next.remove(draftId)
        _state.value = _state.value.copy(selected = next)
    }

    fun toggleAll() {
        val state = _state.value
        _state.value = state.copy(
            selected = if (state.allSelected) emptySet() else state.drafts.map { it.id }.toSet(),
        )
    }

    fun saveDraft(draft: DraftListing, title: String?, description: String?, priceText: String) {
        act(UiMessage(R.string.autolister_draft_saved)) {
            drafts.save(
                draftId = draft.id,
                title = title,
                description = description,
                price = DraftBulk.parsePrice(priceText),
            )
        }
    }

    fun deleteDraft(draft: DraftListing) = act(UiMessage(R.string.autolister_draft_deleted)) {
        drafts.delete(draft.id)
    }

    /**
     * US-1361: schedule this draft to publish, or clear the schedule.
     *
     * Nothing on the phone waits for the time — the write is UTC and a server
     * cron takes it live, so the drop happens with the app closed.
     */
    fun schedule(draft: DraftListing, date: java.time.LocalDate, time: java.time.LocalTime) {
        val zone = java.time.ZoneId.systemDefault()
        val instant = ScheduledDrops.toInstant(date, time, zone)
        val note = ScheduledDrops.scheduleNote(date, time, zone)
            ?: if (ScheduledDrops.isDue(instant, java.time.Instant.now())) {
                ScheduledDrops.PAST_TIME_NOTE
            } else {
                null
            }
        act(
            note ?: UiMessage(
                R.string.autolister_scheduled_for,
                args = listOf(ScheduledDrops.formatLocal(instant.atZone(zone))),
            ),
        ) { drafts.schedule(draft.id, instant.toString()) }
    }

    fun clearSchedule(draft: DraftListing) = act(UiMessage(R.string.autolister_schedule_cleared)) {
        drafts.schedule(draft.id, null)
    }

    fun bulkPrice(change: DraftBulk.PriceChange) {
        val state = _state.value
        if (state.selected.isEmpty()) return
        act(null) {
            val updated = drafts.bulkPrice(state.drafts, state.selected, change)
            _state.value = _state.value.copy(
                banner = updatedBanner(updated),
            )
        }
    }

    fun bulkText(title: String?, description: String?) {
        val selected = _state.value.selected
        if (selected.isEmpty()) return
        act(null) {
            val updated = drafts.bulkText(selected, title, description)
            _state.value = _state.value.copy(
                banner = updatedBanner(updated),
            )
        }
    }

    /**
     * US-2408: what this draft looks like on every other marketplace.
     *
     * Asked of the server rather than assembled here. Title caps, condition
     * vocabularies and category trees differ per marketplace and change
     * without an app release, so a phone that built these itself would be
     * wrong the first time Poshmark renamed a condition — and the seller would
     * only find out when the listing was refused.
     *
     * One billed AI action covers every platform in the request, which is why
     * they all go in one call rather than one per platform.
     */
    fun loadPlatformFields(itemId: String) {
        if (_state.value.loadingPlatformFields) return
        _state.value = _state.value.copy(loadingPlatformFields = true, errorMessage = null)
        viewModelScope.launch {
            runCatching { service.platformFields(itemId, CROSS_LIST_PLATFORMS) }
                .onSuccess { _state.value = _state.value.copy(platformFields = it) }
                .onFailure {
                    _state.value = _state.value.copy(errorMessage = service.message(it))
                }
            _state.value = _state.value.copy(loadingPlatformFields = false)
        }
    }

    fun dismissPlatformFields() {
        _state.value = _state.value.copy(platformFields = null)
    }

    fun dismissMessages() {
        _state.value = _state.value.copy(banner = null, errorMessage = null)
    }

    /**
     * US-2976: "draft" versus "drafts" was an `if (n == 1)` written in
     * English. A plurals resource is the only form that survives a language
     * with more than two.
     */
    private fun updatedBanner(updated: Int) = UiMessage(
        R.plurals.autolister_updated_drafts,
        args = listOf(updated),
        quantity = updated,
    )

    private fun act(successMessage: UiMessage?, action: suspend () -> Unit) {
        if (_state.value.busy) return
        _state.value = _state.value.copy(busy = true, errorMessage = null, banner = null)
        viewModelScope.launch {
            runCatching { action() }
                .onSuccess {
                    successMessage?.let { _state.value = _state.value.copy(banner = it) }
                    _state.value = _state.value.copy(busy = false)
                    loadDrafts()
                }
                .onFailure {
                    _state.value = _state.value.copy(
                        busy = false,
                        errorMessage = service.message(it),
                    )
                }
        }
    }

    override fun onCleared() {
        pollJob?.cancel()
        super.onCleared()
    }

    private companion object {
        /**
         * The non-eBay marketplaces `/platform-fields` knows about.
         *
         * eBay is absent because it is the SOURCE draft this endpoint reads
         * from — asking for an eBay variant of an eBay listing is what the
         * server refuses with "no eBay draft".
         */
        val CROSS_LIST_PLATFORMS = listOf(
            "poshmark",
            "mercari",
            "depop",
            "grailed",
            "etsy",
            "whatnot",
            "vinted",
            "facebook",
        )
    }
}
