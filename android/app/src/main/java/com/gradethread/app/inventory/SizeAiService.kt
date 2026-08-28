package com.gradethread.app.inventory

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeApiError
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-1345: `POST /api/flipdesk/ai/size`.
 *
 * **This infers a SIZE LABEL, not measurements.** The story's AC reads
 * "infers measurements from photos and fills the fields", but the endpoint
 * returns `{ size, gender, confidence, rationale }` — it READS any visible
 * measurements as evidence and answers with the size the brand would print on
 * the tag ("M", "W30 L32", "EU 42"). There is no measurement-inference endpoint
 * on the edge at all. It is wired to what it actually does; see the story note.
 *
 * Motivating case is a garment whose size label is missing or cut off.
 */
@Serializable
data class SizeEstimate(
    /** Best-guess label the way THIS brand writes it; "" when undeterminable. */
    val size: String = "",
    /** "Men" | "Women" | "Unisex" | "Kids", or null. */
    val gender: String? = null,
    val confidence: Double = 0.0,
    val rationale: String = "",
    /** The server's own verdict — never re-derived from a local threshold. */
    @SerialName("low_confidence") val lowConfidence: Boolean = false,
) {
    /**
     * Whether there is anything to offer the seller.
     *
     * An empty size is a real answer ("I can't tell") and must not be presented
     * as a suggestion — filling the field with "" would clear a size they had
     * already typed.
     */
    val isUsable: Boolean get() = size.isNotBlank()

    val confidencePercent: Int get() = Math.round(confidence.coerceIn(0.0, 1.0) * 100).toInt()
}

@Serializable
private data class SizeRequest(@SerialName("item_id") val itemId: String)

@Singleton
class SizeAiService @Inject constructor(
    /** The long-idle profile: this is a vision call, like extract and snap. */
    @Named("ai") private val edge: EdgeApi,
) {

    companion object {
        const val SIZE_PATH = "/api/flipdesk/ai/size"
    }

    suspend fun estimate(itemId: String): SizeEstimate {
        val body = json.encodeToString(SizeRequest.serializer(), SizeRequest(itemId))
        val raw = edge.postRaw(SIZE_PATH, body)
        return try {
            json.decodeFromString(SizeEstimate.serializer(), raw)
        } catch (t: Throwable) {
            throw EdgeApiError.Decoding(t.message ?: "unparseable size response", t)
        }
    }

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }
}
