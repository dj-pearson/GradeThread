package com.gradethread.app.settings

import android.content.Context
import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-2412: `GET /api/account/export` — the data-access right, on the phone.
 *
 * **The request carries no user id.** The server reads the subject from the
 * bearer token (`c.get("userId")`), and that is the only correct design: an id
 * in the request is an id a caller could change, and the one thing a
 * data-access endpoint must never do is hand one person another person's file.
 * There is nothing to pass, so nothing is passed.
 *
 * The bytes are written to a private cache file and handed to the share sheet.
 * Nothing is written to shared storage: the export is the subject's whole
 * account in one document, and dropping a copy into Downloads would make a
 * second, permanent copy that nobody asked for and nothing sweeps.
 */
@Singleton
class AccountExportService @Inject constructor(
    @ApplicationContext private val context: Context,
    /**
     * The shared profile, matching iOS. Its 20s idle cap is deliberate: a
     * stalled export otherwise sits behind a spinner for a minute with no way
     * out, and the server streams this response, so idle really does mean
     * stalled.
     */
    @Named("shared") private val edge: EdgeApi,
) {

    /**
     * Fetch the export and stage it for sharing.
     *
     * Returns the file to hand to the share sheet. The caller deletes it once
     * the sheet is done — see [sweep].
     */
    suspend fun export(): File = withContext(Dispatchers.IO) {
        val json = edge.getRaw(EXPORT_PATH)
        val dir = File(context.cacheDir, DIR).apply { mkdirs() }
        // Swept before writing rather than after sharing: the share sheet gives
        // no reliable "finished" callback, so the guarantee worth making is
        // that yesterday's export is not still sitting there today.
        sweep(dir)
        File(dir, FILE_NAME).apply { writeText(json) }
    }

    /** Drop every staged export. */
    fun sweep(dir: File = File(context.cacheDir, DIR)) {
        runCatching { dir.listFiles()?.forEach { it.delete() } }
    }

    companion object {
        const val EXPORT_PATH = "/api/account/export"

        /** Its own cache subdirectory, and the ONLY path the provider grants. */
        const val DIR = "account-export"

        /** Matches the server's Content-Disposition and iOS's temp file. */
        const val FILE_NAME = "gradethread-export.json"

        const val MIME = "application/json"

        fun message(error: Throwable): String =
            (error as? EdgeApiError)?.userMessage()
                ?: error.message
                ?: "We couldn't build your export just now."
    }
}
