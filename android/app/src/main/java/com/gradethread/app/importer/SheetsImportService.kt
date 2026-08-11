package com.gradethread.app.importer

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-2410: pulling a Google Sheet down as CSV.
 *
 * The server does the fetching, not the phone. A published sheet is served from
 * Google with cookies and redirects that an app has no business following, and
 * the edge already knows how to tell "not shared" from "not reachable" — a
 * distinction the phone cannot make from a 200 that contains a login page.
 *
 * Behind an interface so the not-shared path can be tested without a network.
 */
interface SheetsImporting {
    /** The sheet's first tab (or the `#gid=` one) as raw CSV text. */
    suspend fun fetchCsv(url: String): String
}

@Serializable
private data class FetchSheetRequest(val url: String)

@Serializable
internal data class FetchSheetResponse(
    val csv: String = "",
    val gid: String? = null,
    @SerialName("spreadsheet_id") val spreadsheetId: String? = null,
)

@Singleton
class SheetsImportService @Inject constructor(
    /** The shared profile: this is a download, not a vision call. */
    @Named("shared") private val edge: EdgeApi,
) : SheetsImporting {

    override suspend fun fetchCsv(url: String): String = edge.json.decodeFromString(
        FetchSheetResponse.serializer(),
        edge.postRaw(
            FETCH_CSV_PATH,
            edge.json.encodeToString(FetchSheetRequest.serializer(), FetchSheetRequest(url.trim())),
        ),
    ).csv

    companion object {
        const val FETCH_CSV_PATH = "/api/flipdesk/sheets/fetch-csv"

        /**
         * The message to show for a failed fetch.
         *
         * **The server's sentence wins, always.** A sheet that is not shared
         * comes back 403 naming the exact setting to change — "Share → General
         * access → Anyone with the link (Viewer)" — and nothing on the device
         * could work that out. Replacing it with a generic permission message
         * would leave the seller with a failure and no fix, which is the whole
         * point of this path having its own copy.
         *
         * There are two distinct 403s (an outright refusal from Google, and a
         * 200 carrying the login page after a redirect) with two different
         * sentences, and both are worth showing verbatim.
         */
        fun message(error: Throwable): String =
            (error as? EdgeApiError)?.userMessage()
                ?: error.message
                ?: "We couldn't read that sheet."
    }
}
