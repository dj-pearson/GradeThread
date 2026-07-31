package com.gradethread.app.intake

import android.content.Context
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.IntakeBatchEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import java.io.File
import java.util.UUID

/**
 * US-1382: where a shared batch lives until the app opens.
 *
 * Two halves that must stay in step: a row in Room, and a directory of JPEGs
 * under `filesDir/intake-inbox/<id>/`. The files are COPIED rather than
 * referenced, because a `content://` Uri's read grant dies with the Activity
 * that received it — a stored Uri would be unreadable by the time anyone
 * opened the app, which is the entire window this feature covers.
 */
object IntakeInboxStore {

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    fun directory(context: Context): File =
        File(context.filesDir, "intake-inbox").apply { mkdirs() }

    fun batchDirectory(context: Context, id: String): File =
        File(directory(context), id).apply { mkdirs() }

    fun newBatchId(): String = UUID.randomUUID().toString().lowercase()

    suspend fun write(
        db: GradeThreadDb,
        id: String,
        photos: List<IntakeInbox.PhotoEntry>,
        nowMs: Long,
    ) {
        db.intakeBatches().upsert(
            IntakeBatchEntity(
                id = id,
                photosJson = json.encodeToString(
                    kotlinx.serialization.builtins.ListSerializer(
                        IntakeInbox.PhotoEntry.serializer(),
                    ),
                    photos,
                ),
                createdAt = nowMs,
            ),
        )
    }

    /** Oldest first. An unreadable row is dropped, not thrown — see [consume]. */
    suspend fun pending(db: GradeThreadDb): List<IntakeInbox.Batch> =
        db.intakeBatches().all().mapNotNull { row ->
            runCatching {
                IntakeInbox.Batch(
                    id = row.id,
                    createdAt = row.createdAt,
                    photos = json.decodeFromString(
                        kotlinx.serialization.builtins.ListSerializer(
                            IntakeInbox.PhotoEntry.serializer(),
                        ),
                        row.photosJson,
                    ),
                )
            }.onFailure {
                Telemetry.breadcrumb("intake batch unreadable: ${it.message}", "intake")
            }.getOrNull()
        }

    /**
     * Row first, then files.
     *
     * A crash between the two leaves orphaned JPEGs, which [sweepOrphans]
     * clears. The other order leaves a row pointing at files that are gone,
     * which presents the seller with an empty intake and no explanation.
     */
    suspend fun consume(context: Context, db: GradeThreadDb, id: String) =
        withContext(Dispatchers.IO) {
            db.intakeBatches().delete(id)
            File(directory(context), id).deleteRecursively()
            Unit
        }

    /**
     * Sign-out: nothing staged survives.
     *
     * A shared photo is someone's garment, in their house. The next person to
     * sign in on this device must not inherit it.
     */
    suspend fun clearAll(context: Context, db: GradeThreadDb) = withContext(Dispatchers.IO) {
        db.intakeBatches().clearAll()
        directory(context).deleteRecursively()
        Unit
    }

    /** Directories with no row left — the crash window in [consume]. */
    suspend fun sweepOrphans(context: Context, db: GradeThreadDb) = withContext(Dispatchers.IO) {
        val known = db.intakeBatches().all().map { it.id }.toSet()
        directory(context).listFiles()
            ?.filter { it.isDirectory && it.name !in known }
            ?.forEach { it.deleteRecursively() }
        Unit
    }
}
