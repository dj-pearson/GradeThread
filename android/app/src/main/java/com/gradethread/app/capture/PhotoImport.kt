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
    ): List<Result<Imported>> = withContext(Dispatchers.IO) {
        val staging = File(context.cacheDir, "import-staging").apply { mkdirs() }
        val results = uris.take(MAX_PICK).mapIndexed { index, uri ->
            runCatching {
                val staged = File(staging, "pick_${now()}_$index.jpg")
                context.contentResolver.openInputStream(uri)?.use { input ->
                    staged.outputStream().use { input.copyTo(it) }
                } ?: error("unreadable pick: $uri")

                // Capture date BEFORE processing (the output has no EXIF).
                val captureDate = runCatching {
                    parseExifDateTime(
                        ExifInterface(staged.absolutePath)
                            .getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL),
                    )
                }.getOrNull() ?: now()

                val processed = PhotoProcessor.process(staged, outputDir)
                staged.delete()
                Imported(processed, captureDate)
            }
        }
        results
    }
}
