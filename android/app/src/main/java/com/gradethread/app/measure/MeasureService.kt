package com.gradethread.app.measure

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-1576: the four `/api/flipdesk/measure` calls, mirroring the iOS
 * `MeasureService`.
 *
 * **No computer vision runs on the device.** Marker detection, the homography
 * and the landmark proposals are all server-side by design (US-1572/1573), so
 * every platform measures with the same ruler and a fix ships once. Android's
 * job is to draw what comes back and to send corrections when the seller
 * disagrees.
 */
@Serializable
data class StoredLine(
    /** Endpoints in ORIGINAL image pixels — the calibration's coordinate space. */
    val e1: List<Double> = emptyList(),
    val e2: List<Double> = emptyList(),
    val inches: Double = 0.0,
    val label: String = "",
) {
    val isUsable: Boolean get() = e1.size == 2 && e2.size == 2
}

@Serializable
data class MeasureCalibration(
    /** Schema version; the editor refuses anything but 1. */
    val v: Int = 0,
    @SerialName("cardVersion") val cardVersion: String? = null,
    val ppi: Double = 0.0,
    /** Row-major 3x3, image px → card-plane inches. */
    val homography: List<Double> = emptyList(),
    /** Present once /extract has proposed lines, or once the seller saved some. */
    val lines: Map<String, StoredLine>? = null,
) {
    val isUsable: Boolean get() = v == 1 && homography.size == 9
}

/**
 * A calibration, plus the document to write back when lines change.
 *
 * Both halves are needed and neither substitutes for the other: [value] is what
 * the editor draws with, [stored] is what the column must keep whole.
 */
data class MeasureCalibrationResult(
    val value: MeasureCalibration,
    val stored: JsonObject,
)

/**
 * A 422 from `/calibrate` that the SELLER can act on — the card was not found,
 * was cut off, was too small in frame, was bent, or the photo was blurry.
 *
 * Its own type because the remedy is a different photo, not a retry: offering
 * "try again" alone would send them round a loop the same image cannot exit.
 * [guidance] is the server's own sentence and is shown verbatim — it names the
 * specific fault, which nothing on the device can work out.
 */
class MeasureQualityFailure(
    val reason: String,
    val guidance: String,
) : Exception(guidance)

@Serializable
data class ProposedMeasurement(
    val key: String = "",
    val label: String = "",
    val inches: Double = 0.0,
    val confidence: Double = 0.0,
    /** The server's own verdict — outside the size-prior band, or low confidence. */
    val flagged: Boolean = false,
    @SerialName("flagReason") val flagReason: String? = null,
)

@Serializable
data class MeasureExtractResult(
    val group: String = "",
    /** The keys actually merged onto the item — a fill-only merge, so this is
     *  a SUBSET of [measurements] and the difference is values the seller
     *  already typed, which are never overwritten. */
    val written: List<String> = emptyList(),
    val measurements: List<ProposedMeasurement> = emptyList(),
)

@Serializable
private data class PhotoIdRequest(@SerialName("photo_id") val photoId: String, val force: Boolean = false)

@Serializable
private data class ItemIdRequest(@SerialName("item_id") val itemId: String)

@Serializable
data class MeasureCorrection(
    val key: String,
    val proposed: Double,
    val final: Double,
    val confidence: Double? = null,
    val flagged: Boolean? = null,
)

@Serializable
private data class CorrectionRequest(
    @SerialName("garment_class") val garmentClass: String,
    val corrections: List<MeasureCorrection>,
)

@Serializable
private data class QualityBody(
    val ok: Boolean = true,
    val reason: String? = null,
    val message: String? = null,
)

@Singleton
class MeasureService @Inject constructor(
    /**
     * The long-idle profile for ALL four calls, matching iOS's `.aiShared`.
     *
     * `/extract` is an obvious vision call, but `/calibrate` also downloads and
     * decodes a full-resolution photo before running marker detection, and the
     * 20s shared cap would abandon a legitimate calibration on a large image —
     * which the seller reads as "the card wasn't found".
     */
    @Named("ai") private val edge: EdgeApi,
) {

    companion object {
        const val CALIBRATE_PATH = "/api/flipdesk/measure/calibrate"
        const val EXTRACT_PATH = "/api/flipdesk/measure/extract"
        const val OVERLAY_PATH = "/api/flipdesk/measure/overlay"
        const val CORRECTION_PATH = "/api/flipdesk/measure/correction"
    }

    private val json = Json { ignoreUnknownKeys = true; isLenient = true; encodeDefaults = true }

    /**
     * Fetch (or recompute) the px→inch calibration for a measurement photo.
     *
     * @param force re-run detection instead of serving the cached calibration —
     *   what the quality banner's "Try again" sends after a retake.
     * @throws MeasureQualityFailure when the server's quality gate rejects the
     *   photo, so the caller can show the remedy instead of a generic error.
     */
    suspend fun calibrate(photoId: String, force: Boolean = false): MeasureCalibrationResult {
        val body = json.encodeToString(PhotoIdRequest.serializer(), PhotoIdRequest(photoId, force))
        val raw = post(CALIBRATE_PATH, body)
        val document = runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull()
            ?: throw EdgeApiError.Decoding("calibration response was not an object")
        return MeasureCalibrationResult(
            value = decode(MeasureCalibration.serializer(), raw),
            stored = storedDocument(document),
        )
    }

    /**
     * The calibration document as the COLUMN holds it.
     *
     * The response is `{ ok, cached, ...stored }`, and `stored` carries fields
     * this client deliberately does not model — `quality` and `computedAt`. A
     * save that re-serialised the typed object would silently drop both, so the
     * line write merges into the untyped document instead. `ok` and `cached`
     * are transport, not state, and are removed rather than written back.
     */
    private fun storedDocument(response: JsonObject): JsonObject =
        JsonObject(response.filterKeys { it != "ok" && it != "cached" })

    /** One billed AI action: propose every applicable measurement's endpoints. */
    suspend fun extract(photoId: String): MeasureExtractResult {
        val body = json.encodeToString(PhotoIdRequest.serializer(), PhotoIdRequest(photoId))
        return decode(MeasureExtractResult.serializer(), post(EXTRACT_PATH, body))
    }

    /**
     * Ask the server to re-render the buyer-facing overlay image.
     *
     * Fire-and-forget on purpose: the overlay is a listing nicety, and failing
     * a save the seller just made because a cosmetic re-render did not land
     * would lose real work over a cached picture.
     */
    suspend fun regenerateOverlay(itemId: String) {
        runCatching {
            post(OVERLAY_PATH, json.encodeToString(ItemIdRequest.serializer(), ItemIdRequest(itemId)))
        }
    }

    /**
     * Record where the seller moved a line the model had proposed.
     *
     * This is the accuracy gate's ground truth (US-1582), so it is worth
     * sending; it is also never worth failing a save over, hence the same
     * best-effort treatment the server gives it.
     */
    suspend fun recordCorrections(garmentClass: String, corrections: List<MeasureCorrection>) {
        if (corrections.isEmpty()) return
        runCatching {
            post(
                CORRECTION_PATH,
                json.encodeToString(
                    CorrectionRequest.serializer(),
                    // The server caps the batch at 20; sending 21 fails the whole
                    // call, so the tail is dropped here rather than losing all of it.
                    CorrectionRequest(garmentClass.take(40), corrections.take(20)),
                ),
            )
        }
    }

    private suspend fun post(path: String, body: String): String =
        try {
            edge.postRaw(path, body)
        } catch (error: EdgeApiError.BadRequest) {
            // A 422 arrives as BadRequest, and the quality-gate body carries no
            // `error` key at all — so `detail` falls back to a preview of the
            // raw JSON. Showing that to a seller would put `{"ok":false,...}` in
            // a toast, which is why the body is decoded rather than the detail.
            throw quality(error) ?: error
        }

    private fun quality(error: EdgeApiError.BadRequest): MeasureQualityFailure? {
        val body = error.body ?: return null
        val decoded = runCatching { json.decodeFromString(QualityBody.serializer(), body) }.getOrNull()
            ?: return null
        if (decoded.ok) return null
        val message = decoded.message?.takeIf { it.isNotBlank() } ?: return null
        return MeasureQualityFailure(decoded.reason.orEmpty(), message)
    }

    private fun <T> decode(serializer: kotlinx.serialization.KSerializer<T>, raw: String): T =
        try {
            json.decodeFromString(serializer, raw)
        } catch (t: Throwable) {
            throw EdgeApiError.Decoding(t.message ?: "unparseable measure response", t)
        }
}
