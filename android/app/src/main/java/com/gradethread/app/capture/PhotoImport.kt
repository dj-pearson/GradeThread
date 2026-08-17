package com.gradethread.app.capture

import android.content.Context
import android.net.Uri
import androidx.exifinterface.media.ExifInterface
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * US-1327: library import via the Android Photo Picker — multi-select up to
 * [MAX_PICK], images-only, and NO storage permission (the picker runs in its
 * own process and hands back scoped URIs).
 *
 * Every picked image flows through the SAME [PhotoProcessor] pipeline as a
 * camera capture (downsize, orientation bake, metadata destruction), and the
 * capture date is read best-effort from the source's EXIF BEFORE the strip —
 * falling back to now (US-1013/US-289: sort order still roughly matches the
 * shoot order when the library has originals).
 */
object PhotoImport {

    const val MAX_PICK = 8

    data class Imported(
        val processed: PhotoProcessor.Processed,
        /** EXIF DateTimeOriginal when present; otherwise the import instant. */
        val captureDateMs: Long,
        /**
         * US-2408: the EXIF time ALONE, null when the file carried none.
         *
         * [captureDateMs] cannot answer this — its fallback is the import
         * instant, which is a fine sort key and a terrible shooting time. The
         * AutoLister handoff sends this field to a server that reads it as
         * "when was this garment photographed", and a hundred photos all
         * stamped with the same import second would read as one long burst and
         * group the whole batch into a single item.
         */
        val exifCapturedAtMs: Long?,
    )

    /** EXIF datetime ("2026:07:03 10:15:30", local-naive) → epoch ms. */
    fun parseExifDateTime(value: String?): Long? {
        if (value.isNullOrBlank()) return null
        return runCatching {
            SimpleDateFormat("yyyy:MM:dd HH:mm:ss", Locale.US)
                .apply { timeZone = TimeZone.getDefault() }
                .parse(value)!!.time
        }.getOrNull()
    }

    /**
     * Import picked URIs: copy each into a private staging file (the
     * processor needs a real path), read the capture date from the SOURCE
     * EXIF (the processed output has none by design), then run the standard
     * pipeline. Per-item Result isolation — one broken pick never sinks the
     * batch.
     */
    suspend fun importPicked(
        context: Context,
        uris: List<Uri>,
        outputDir: File,
        now: () -> Long = System::currentTimeMillis,
        /**
         * US-2408: how many of [uris] to take. Defaults to the single-item
         * capture cap; an AutoLister batch is hundreds of photos of DIFFERENT
         * garments, which is a different job from filling one item's slots.
         */
        limit: Int = MAX_PICK,
        /**
         * US-2639: the per-slot resolution cap for each pick, in order.
         *
         * Empty (the default) means the global cap for everything, which is
         * what the AutoLister batch wants — those are hundreds of photos of
         * DIFFERENT garments with no slot assignment at all. The capture screen
         * passes `PhotoIntakeStore.plannedDestinations`, so an imported serial
         * shot gets the same 3600 a captured one does.
         */
        slotCaps: List<Int> = emptyList(),
    ): List<Result<Imported>> = withContext(Dispatchers.IO) {
        val staging = File(context.cacheDir, "import-staging").apply { mkdirs() }
        val results = uris.take(limit).mapIndexed { index, uri ->
            runCatching {
                val staged = File(staging, "pick_${now()}_$index.jpg")
                context.contentResolver.openInputStream(uri)?.use { input ->
                    staged.outputStream().use { input.copyTo(it) }
                } ?: error("unreadable pick: $uri")

                // Capture date BEFORE processing (the output has no EXIF).
                val exif = runCatching {
                    parseExifDateTime(
                        ExifInterface(staged.absolutePath)
                            .getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL),
                    )
                }.getOrNull()

                val processed = PhotoProcessor.process(
                    staged,
                    outputDir,
                    slotCaps.getOrElse(index) { PhotoProcessor.MAX_LONG_EDGE },
                )
                staged.delete()
                Imported(processed, exif ?: now(), exif)
            }
        }
        results
    }
}
