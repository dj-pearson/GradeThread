package com.gradethread.app.platform.storage

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * US-2895: every directory on this device that holds a seller's own photos.
 *
 * WHY THIS EXISTS. `SessionScope.signOutWipe` emptied Room and three caches and
 * left the garment photos sitting on disk — full-resolution shots of someone's
 * clothes, taken in their house, readable by the next account that signs in on
 * the same phone. The row wipe could not reach them because none of these files
 * is referenced by a row: they are staged on the way to an upload, or cached on
 * the way to a screen.
 *
 * The comment above the sign-out clearances already made this argument for the
 * three caches it did clear — "on a shared phone that is one seller's data
 * sitting in another seller's process" — and `IntakeInboxStore` makes it again
 * for shared-in photos: "someone's garments, in their house". Photos are the
 * largest and most identifying bytes the app holds, and they were the ones not
 * on the list.
 *
 * WHY IT IS A LIST IN ONE PLACE rather than fourteen `delete()` calls in
 * `SettingsViewModel`. A directory added by a future feature has to appear here
 * to be cleared, and nothing about writing `File(context.cacheDir, "new-thing")`
 * reminds anyone of that. So [StagedMediaCoverageTest] scans `src/main` for
 * every `cacheDir`/`filesDir` literal and fails when one is missing from this
 * file — the list cannot silently fall behind the code.
 *
 * ⚠ ADDING A DIRECTORY HERE IS NOT FREE. Everything listed is DELETED on
 * sign-out. Only add a directory whose contents belong to the signed-in seller
 * and are safe to lose; a directory holding cross-account state (a download
 * cache, a config, an app-level asset) must NOT be listed, and the guard test
 * takes an explicit exclusion with a reason instead.
 */
object StagedMedia {

    /**
     * `cacheDir` subdirectories. The OS may evict these under storage pressure,
     * which is precisely why they hold only in-flight work — but "may be
     * evicted eventually" is not "is gone when the account changes".
     */
    val CACHE_DIRS = listOf(
        "ai-ocr", // AiExtractionManager: the label crop sent for attribute extraction
        "autolister", // AutolisterSessionViewModel: batch capture frames
        "canvas-add", // ItemPhotosViewModel: photos being added to an existing item
        "import-staging", // PhotoImport: library picks, mid-processing
        "prospect-capture", // ProspectScreen: in-store shots
        "share-staging", // ShareTargetActivity: photos shared in from another app
        "snap", // SnapViewModel
        "snap-capture", // SnapScreen: camera
        "snap-import", // SnapScreen: library
        "account-export", // AccountExportService: the seller's OWN data export
    )

    /**
     * `filesDir` subdirectories. These are NOT evicted by the OS. Left behind,
     * they persist for the life of the install.
     */
    val FILES_DIRS = listOf(
        "captures", // CaptureScreen: every camera shot staged for upload
        "consumer-grade", // ConsumerGradeViewModel
        "consumer-grade-camera", // GradeCameraSheet
        // NOTE: "intake-inbox" is deliberately absent. IntakeInboxStore.clearAll
        // owns it, and it drops Room rows as well as files — clearing the
        // directory from here too would leave those rows pointing at nothing.
    )

    /** Every staged-media directory, resolved against [context]. */
    fun directories(context: Context): List<File> =
        CACHE_DIRS.map { File(context.cacheDir, it) } + FILES_DIRS.map { File(context.filesDir, it) }

    /**
     * Delete every staged-media directory.
     *
     * Never throws. A failed delete must not strand someone mid-sign-out, and
     * the caller already treats the wipe as best-effort and reports whether
     * bytes were left behind. Returns true when every directory is gone.
     */
    suspend fun clearAll(context: Context): Boolean = withContext(Dispatchers.IO) {
        directories(context).all { dir ->
            runCatching { !dir.exists() || dir.deleteRecursively() }.getOrDefault(false)
        }
    }
}
