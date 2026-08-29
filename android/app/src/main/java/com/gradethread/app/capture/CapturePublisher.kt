package com.gradethread.app.capture

import android.content.Context
import androidx.work.WorkManager
import com.gradethread.app.platform.workspace.WorkspaceScope
import com.gradethread.app.sync.MutationKind
import com.gradethread.app.sync.OfflineMutationQueue
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.upload.UploadWorker
import dagger.hilt.android.qualifiers.ApplicationContext
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.postgrest.from
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-1334: the IO half of publishing a capture session — the handoff the
 * "Continue" button had been missing. All decisions live in
 * [CapturePublishPlan]; this only supplies the seams and the ordering.
 *
 * ORDER MATTERS, and not for cosmetic reasons:
 *  1. the LOCAL Room row goes in first. `item_photos` carries a FOREIGN KEY
 *     onto `inventory_items` (ON DELETE CASCADE), so a photo row inserted by
 *     [UploadWorker] before its parent exists fails the constraint and the
 *     upload is silently lost — the bytes reach storage and nothing links
 *     them (the iOS photo-link lesson, this time enforced by SQLite);
 *  2. the server insert, or a queued create when offline;
 *  3. the uploads, which may complete long after this returns;
 *  4. the draft is dropped only once the row exists, so a crash mid-publish
 *     leaves a recoverable capture session rather than nothing.
 */
@Singleton
class CapturePublisher @Inject constructor(
    private val client: SupabaseClient,
    private val db: GradeThreadDb,
    private val queue: OfflineMutationQueue,
    @ApplicationContext private val context: Context,
) {

    /** Active workspace, else self — matching IntakeRepository. */
    private fun ownerId(): String? = client.auth.currentUserOrNull()?.id?.let { WorkspaceScope.tenantOwnerId(it) }

    /**
     * Publish the session and return the plan the AI step runs against.
     *
     * A server insert failure that [OfflineMutationQueue.shouldEnqueue]
     * classifies as transient is NOT an error: the create rides the mutation
     * queue and the local row already exists, so the seller keeps working.
     * Anything else fails loudly rather than leaving an orphan.
     */
    suspend fun publish(
        state: PhotoIntakeStore.State,
        profile: PhotoProfile = PhotoProfile.clothingFallback,
        nowMs: Long = System.currentTimeMillis(),
    ): Result<CapturePublishPlan.Plan> = runCatching {
        val owner = ownerId() ?: error("Not signed in")
        val plan = CapturePublishPlan.build(
            state = state,
            itemId = UUID.randomUUID().toString().lowercase(),
            ownerId = owner,
            nowMs = nowMs,
            profile = profile,
        )

        db.items().upsert(listOf(localRow(plan.itemId, owner, nowMs)))

        runCatching { client.from(TABLE).insert(plan.item) }.onFailure { error ->
            if (!OfflineMutationQueue.shouldEnqueue(error)) throw error
            queue.enqueue(
                kind = MutationKind.CREATE_INVENTORY_ITEM,
                targetId = plan.itemId,
                payload = plan.item.toString().encodeToByteArray(),
            )
        }

        enqueueUploads(plan)

        db.captureDrafts().delete(PhotoIntakeStore.DRAFT_ID)
        plan
    }

    /**
     * US-2896 AC3: EXPEDITED, because the seller is watching this one.
     *
     * They pressed Publish and the capture flow is showing them progress; the
     * AI extract gate is also waiting on these exact uploads before it will
     * run. That is the definition used throughout: expedited means a human is
     * looking at a spinner that this work is behind, not merely that the work
     * is important.
     *
     * The quota fallback is RUN_AS_NON_EXPEDITED_WORK_REQUEST, so exhausting it
     * makes the upload slower rather than making it disappear.
     */
    private fun enqueueUploads(plan: CapturePublishPlan.Plan) {
        val work = WorkManager.getInstance(context)
        plan.uploads.forEach { entry ->
            work.enqueue(
                UploadWorker.request(
                    UploadWorker.Input(
                        stagedPath = entry.stagedPath,
                        itemId = plan.itemId,
                        serverType = entry.serverPhotoType,
                        sortOrder = entry.sortOrder,
                        capturedAt = entry.capturedAtMs,
                        // US-2498: the role half of the pair. Nothing wrote it
                        // before, so every photo Android captured landed unroled
                        // and the retag menu was the only way to say what a shot
                        // showed — even when the seller had picked the named slot.
                        photoRole = entry.photoRole,
                        expedited = true,
                    ),
                ),
            )
        }
    }

    /**
     * The local mirror of the row we just inserted.
     *
     * `hasLocalChanges` stays FALSE: nothing here is a local edit the sync
     * engine must defend — either the insert landed, or the mutation queue
     * owns replaying it. Marking it dirty would make the next pull treat the
     * server's own copy as a conflict.
     */
    private fun localRow(itemId: String, owner: String, nowMs: Long) = InventoryItemEntity(
        id = itemId,
        userId = owner,
        title = CapturePublishPlan.PLACEHOLDER_TITLE,
        brand = null,
        sku = null,
        size = null,
        color = null,
        material = null,
        status = CapturePublishPlan.INITIAL_STATUS,
        itemCategory = null,
        garmentType = null,
        garmentCategory = null,
        itemDescription = null,
        style = null,
        sourcedBy = null,
        acquiredDate = null,
        container = null,
        compSetJson = null,
        sourceId = null,
        locationBin = null,
        consignorId = null,
        consignmentSplitPct = null,
        acquiredPrice = null,
        targetPrice = null,
        listingPrice = null,
        gradeValue = null,
        gradeLabel = null,
        certificateUrl = null,
        gradeReportId = null,
        disputeStatus = null,
        conditionNotes = null,
        measurementsJson = null,
        primaryPhotoUrl = null,
        createdAt = nowMs,
        updatedAt = nowMs,
    )

    private companion object {
        const val TABLE = "inventory_items"
    }
}
