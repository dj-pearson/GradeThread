package com.gradethread.app.disclosure

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-1360: the disclosure endpoints.
 *
 * `apply-to-listing` edits a LIVE eBay description, so its result is reported
 * verbatim rather than assumed — see [DisclosureViewModel].
 */
@Singleton
class DisclosureService @Inject constructor(
    @Named("shared") private val edge: EdgeApi,
) {

    companion object {
        fun itemPath(itemId: String) = "/api/flipdesk/disclosure/item/$itemId"
        fun annotatedPhotoPath(itemId: String) = "${itemPath(itemId)}/annotated-photo"
        fun applyPath(itemId: String) = "${itemPath(itemId)}/apply-to-listing"
    }

    suspend fun disclosure(itemId: String): DisclosureData = edge.json.decodeFromString(
        DisclosureData.serializer(),
        edge.getRaw(itemPath(itemId)),
    )

    /**
     * Upload one annotated composite.
     *
     * [dataUrl] must be a base64 PNG data URL — the server sniffs the real
     * bytes and refuses anything else, because this lands in the PUBLIC bucket
     * where an SVG smuggled behind a png prefix would be served as stored.
     */
    suspend fun saveAnnotated(
        itemId: String,
        imageType: String,
        dataUrl: String,
    ): SaveAnnotatedResponse = edge.json.decodeFromString(
        SaveAnnotatedResponse.serializer(),
        edge.postRaw(
            annotatedPhotoPath(itemId),
            edge.json.encodeToString(
                AnnotatedPhotoRequest.serializer(),
                AnnotatedPhotoRequest(imageType, dataUrl),
            ),
        ),
    )

    /** Push the disclosure text into the live listing's description. */
    suspend fun applyToListing(itemId: String): ApplyDisclosureResponse =
        edge.json.decodeFromString(
            ApplyDisclosureResponse.serializer(),
            edge.postRaw(applyPath(itemId), "{}"),
        )

    fun message(error: Throwable): String =
        (error as? EdgeApiError)?.userMessage()
            ?: error.message
            ?: "Couldn't reach the disclosure service."
}
