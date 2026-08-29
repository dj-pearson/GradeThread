package com.gradethread.app.ai

import android.content.Context
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.gradethread.app.capture.CapturePublishPlan
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.SyncTrigger
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.upload.PhotoSignedUrlProvider
import com.gradethread.app.upload.UploadWorker
import com.gradethread.app.vision.TagTextRecognizer
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.io.File
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-1334: runs the post-capture extraction OFF the screen's lifecycle, so
 * dismissing the AI step lets it finish in the background (iOS
 * `AIExtractionManager`).
 *
 * A @Singleton with its OWN scope, deliberately: the run outlives the
 * composable that started it, and the seller is explicitly offered "keep it
 * running in the background". A viewModelScope would cancel the ~40s call the
 * moment they navigate away, which is exactly the affordance we're offering.
 *
 * The branch logic itself lives in [AiExtractFlow]; this owns the IO — the
 * upload gate, URL building, OCR, telemetry, and the title seed.
 */
@Singleton
class AiExtractionManager @Inject constructor(
    private val db: GradeThreadDb,
    private val service: AiExtractService,
    private val writer: AiFieldWriter,
    private val signedUrls: PhotoSignedUrlProvider,
    private val syncTrigger: SyncTrigger,
    @ApplicationContext private val context: Context,
) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _phases = MutableStateFlow<Map<String, AiExtractPhase>>(emptyMap())
    val phases: StateFlow<Map<String, AiExtractPhase>> = _phases.asStateFlow()

    /** itemId → the review waiting to be confirmed. Survives navigation. */
    private val _reviews = MutableStateFlow<Map<String, AiExtractReview.Review>>(emptyMap())
    val reviews: StateFlow<Map<String, AiExtractReview.Review>> = _reviews.asStateFlow()

    private val jobs = mutableMapOf<String, Job>()

    fun phase(itemId: String): AiExtractPhase? = _phases.value[itemId]

    fun review(itemId: String): AiExtractReview.Review? = _reviews.value[itemId]

    fun isRunning(itemId: String): Boolean = _phases.value[itemId]?.isRunning == true

    /**
     * Start an extraction. IDEMPOTENT per item — re-entering the screen or a
     * recomposition must never double-run the AI, which would double-charge
     * the seller's quota.
     */
    fun start(
        itemId: String,
        uploads: List<CapturePublishPlan.UploadEntry>,
        gateSortOrders: Set<Int>,
        isOnline: Boolean,
    ) {
        if (jobs[itemId]?.isActive == true) return
        setPhase(itemId, AiExtractGate.progress(landed = 0, total = uploads.size))
        jobs[itemId] = scope.launch {
            runCatching { run(itemId, uploads, gateSortOrders, isOnline) }
                .onFailure { setPhase(itemId, AiExtractPhase.Failed(AiExtractMessages.forError(it))) }
            jobs.remove(itemId)
        }
    }

    /** Drop tracking for an item and cancel any in-flight run. */
    fun clear(itemId: String) {
        jobs.remove(itemId)?.cancel()
        _phases.value = _phases.value - itemId
        _reviews.value = _reviews.value - itemId
    }

    /** The seller confirmed (or skipped) the review — it is consumed. */
    fun consumeReview(itemId: String) {
        _reviews.value = _reviews.value - itemId
    }

    // ── The run ──────────────────────────────────────────────────────────

    private suspend fun run(
        itemId: String,
        uploads: List<CapturePublishPlan.UploadEntry>,
        gateSortOrders: Set<Int>,
        isOnline: Boolean,
    ) {
        // The tag capture is copied aside BEFORE the gate: UploadWorker
        // deletes the staged file the moment its row lands, and the
        // post-success gap fill (US-1333) still needs those bytes. One small
        // copy beats an OCR pass that silently finds nothing.
        val tagCopy = stashTagPhoto(itemId, uploads)

        try {
            if (isOnline) awaitUploads(itemId, uploads, gateSortOrders)

            val photos = if (isOnline) extractPhotos(itemId) else emptyList()

            val result = AiExtractFlow.run(
                itemId = itemId,
                isOnline = isOnline,
                photos = photos,
                // The undo target for title is the PLACEHOLDER, not null:
                // `title` is NOT NULL server-side, so an undo that resolved to
                // an empty value would try to clear the column and fail the
                // whole write.
                existingValues = mapOf("title" to CapturePublishPlan.PLACEHOLDER_TITLE),
                extract = { sending ->
                    setPhase(itemId, AiExtractPhase.Running)
                    service.extract(AiExtractRequest(itemId = itemId, photos = sending))
                },
                ocrLines = { tagCopy?.let { ocrLines(it) } ?: emptyList() },
                liveTextOnly = { lines -> service.liveTextOnlyResponse(lines) },
                mergeGaps = { response, lines -> service.mergeLiveTextGaps(response, lines) },
            )

            result.emissions.forEach { Telemetry.event(it.name, it.props) }

            when (val outcome = result.outcome) {
                is AiExtractFlow.Outcome.Ready -> {
                    seedTitle(itemId, outcome.review)
                    _reviews.value = _reviews.value + (itemId to outcome.review)
                    setPhase(itemId, AiExtractPhase.Ready)
                    // The title seed and any server-side gap fill landed on the
                    // SERVER row only; without a pull the local row keeps
                    // showing "Untitled item" until the next foreground.
                    runCatching { syncTrigger.refresh() }
                }

                is AiExtractFlow.Outcome.Failed ->
                    setPhase(itemId, AiExtractPhase.Failed(outcome.message))
            }
        } finally {
            tagCopy?.delete()
        }
    }

    /**
     * Hold until the gate photos settle, publishing progress each tick.
     *
     * "Settled" = an `item_photos` row exists (the upload is confirmed end to
     * end) OR the worker reached a terminal failure. Room is the source of
     * truth for success because that row is what the extract request is built
     * from — a finished WorkInfo whose row never landed is not a usable photo.
     */
    private suspend fun awaitUploads(
        itemId: String,
        uploads: List<CapturePublishPlan.UploadEntry>,
        gateSortOrders: Set<Int>,
    ) {
        val work = WorkManager.getInstance(context)
        var elapsed = 0L
        while (true) {
            val landed = db.photos().forItem(itemId).map { it.sortOrder }.toSet()
            val failed = failedSortOrders(work, itemId)
            setPhase(itemId, AiExtractGate.progress(landed.size, uploads.size))
            if (AiExtractGate.isSettled(gateSortOrders, landed + failed, elapsed)) return
            delay(AiExtractGate.POLL_INTERVAL_MS)
            elapsed += AiExtractGate.POLL_INTERVAL_MS
        }
    }

    /**
     * Which of this item's uploads have failed TERMINALLY.
     *
     * US-2896 AC6, re-checked when the network constraint landed. Only FAILED
     * and CANCELLED count, and after US-2896 that is finally the truth rather
     * than an approximation of it.
     *
     * BEFORE: with no constraint, an offline upload ran immediately, the PUT
     * failed, the attempts drained, and WorkManager reported FAILED. That state
     * was indistinguishable here from a terminal 4xx - the gate treated "this
     * seller walked into a lift" as "this photo is never arriving", opened, and
     * ran the AI without it.
     *
     * AFTER: an offline upload is BLOCKED on its constraint. WorkManager does
     * not run it, does not consume an attempt, and does not report FAILED - so
     * it is correctly absent from this set and the gate keeps waiting.
     *
     * WHAT THAT COSTS, because it is not free: an offline seller now waits the
     * full AiExtractGate.TIMEOUT_MS (180s) before the gate gives up, where they
     * used to get a fast failure. That is the better trade in both directions.
     * The fast failure was WRONG - it ran the AI on a partial photo set - and
     * the photos themselves survive now: they upload when signal returns
     * instead of dying with a spent retry budget.
     *
     * DO NOT add ENQUEUED or BLOCKED to this filter to restore the old speed.
     * That would reinstate exactly the ambiguity the constraint removed.
     */
    private suspend fun failedSortOrders(work: WorkManager, itemId: String): Set<Int> = runCatching {
        work.getWorkInfosByTagFlow(UploadWorker.itemTag(itemId)).first()
            .filter { it.state == WorkInfo.State.FAILED || it.state == WorkInfo.State.CANCELLED }
            .mapNotNull { info -> UploadWorker.sortOrderFromTags(info.tags) }
            .toSet()
    }.getOrDefault(emptySet())

    private suspend fun extractPhotos(itemId: String): List<AiExtractPhoto> {
        val rows = db.photos().forItem(itemId).map { row ->
            AiExtractPhotos.Row(
                photoType = row.photoType,
                photoUrl = row.photoUrl,
                storagePath = row.storagePath,
                sortOrder = row.sortOrder,
                photoRole = row.photoRole,
            )
        }
        return AiExtractPhotos.build(
            rows = rows,
            resolve = { bucket, path, publicUrl ->
                signedUrls.displayUrl(bucket, path, publicUrl)
            },
        )
    }

    /**
     * Give the item a real name.
     *
     * Guarded on the title still being the placeholder in the WHERE clause,
     * not read-then-write: the run takes ~40s and the seller may well have
     * typed a title in the meantime. Losing their words to a model guess
     * would be the worst outcome here, and a conditional UPDATE makes the
     * race unloseable rather than merely unlikely.
     */
    private suspend fun seedTitle(itemId: String, review: AiExtractReview.Review) {
        if (review.applied.any { it.field == "title" }) return
        val suggestions = buildMap {
            review.applied.forEach {
                put(it.field, FieldSuggestion(it.value, it.confidence, it.source))
            }
            review.lowConfidence.forEach { put(it.field, it.suggestion) }
        }
        val seed = AiExtractReview.bestTitleSeed(suggestions) ?: return
        runCatching {
            writer.seedTitle(itemId, seed, replacing = CapturePublishPlan.PLACEHOLDER_TITLE)
        }
    }

    private fun stashTagPhoto(itemId: String, uploads: List<CapturePublishPlan.UploadEntry>): File? {
        // US-2498: any TAG slot, whatever role it carries. An `== TAG` check
        // matched nothing the moment a profile could name three of them
        // (`tag:brand`, `tag:size`, `tag:care`), which silently turned the OCR
        // fallback off for every seller with a suit.
        val tag = uploads.firstOrNull { it.slot.isTagSlot } ?: return null
        return runCatching {
            val source = File(tag.stagedPath)
            if (!source.exists()) return null
            val dir = File(context.cacheDir, "ai-ocr").apply { mkdirs() }
            val copy = File(dir, "$itemId.jpg")
            source.copyTo(copy, overwrite = true)
            copy
        }.getOrNull()
    }

    private suspend fun ocrLines(file: File): List<String> = TagTextRecognizer().use { it.recognizeLines(file) }

    private fun setPhase(itemId: String, phase: AiExtractPhase) {
        // Compare before assign (the iOS US-1519 lesson): this runs 4×/s for
        // up to 3 minutes, and every write re-renders each observing row.
        if (_phases.value[itemId] == phase) return
        _phases.value = _phases.value + (itemId to phase)
    }
}
