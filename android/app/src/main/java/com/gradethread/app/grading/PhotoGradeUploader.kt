package com.gradethread.app.grading

import com.gradethread.app.platform.net.EdgeApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** One photo, already downscaled and JPEG-encoded. */
class PhotoGradeImage(
    /** GRADING vocabulary (front / back / label / detail), not the FlipDesk one.
     *  Build it with [PhotoGradeContract.gradingImageType]. */
    val gradingType: String,
    val jpeg: ByteArray,
)

/** Everything the route needs that is not a photo. */
data class PhotoGradeRequest(
    val garmentType: String,
    val garmentCategory: String,
    val title: String,
    val tier: String = "standard",
    val brand: String? = null,
    val description: String? = null,
    /** The seller's inventory item this grade belongs to. */
    val inventoryItemId: String? = null,
    /** A buyer's closet item, for the consumer journey. */
    val closetItemId: String? = null,
)

/** The submit reply. */
@Serializable
data class PhotoSubmitResponse(
    @SerialName("submission_id") val submissionId: String? = null,
    val paid: Boolean = false,
)

/**
 * US-2815: the non-file fields, in one place so a test can read them without
 * building a multipart body.
 *
 * The Kotlin twin of iOS `PhotoGradeFields`. `verified_capture_opt_in` is sent
 * explicitly false rather than omitted, for the reason the iOS uploader gives:
 * the server re-checks either way, and leaving a request's meaning to a default
 * lets that default change without this client knowing.
 */
object PhotoGradeFields {
    fun fields(request: PhotoGradeRequest): List<Pair<String, String>> {
        val out = mutableListOf(
            "garment_type" to request.garmentType,
            "garment_category" to request.garmentCategory,
            "title" to request.title,
            "tier" to request.tier,
            "verified_capture_opt_in" to "false",
            "authenticity_addon" to "false",
        )
        request.brand?.takeIf { it.isNotEmpty() }?.let { out += "brand" to it }
        request.description?.takeIf { it.isNotEmpty() }?.let { out += "description" to it }
        request.closetItemId?.takeIf { it.isNotEmpty() }?.let { out += "closet_item_id" to it }
        request.inventoryItemId?.takeIf { it.isNotEmpty() }?.let {
            out += "inventory_item_id" to it
        }
        return out
    }
}

/** Why a submission was refused before it was sent. */
sealed class PhotoGradeError(val message: String) {
    class MissingRequired(val types: List<String>) : PhotoGradeError(
        "Add the ${types.joinToString(", ") { friendlyName(it) }} photo before grading. " +
            "The grader needs those to score condition.",
    )

    class TooManyImages(val count: Int) : PhotoGradeError(
        "That's $count photos. A grade takes at most ${PhotoGradeContract.MAX_IMAGES}.",
    )

    object NoImages : PhotoGradeError("Add photos before grading.")

    companion object {
        /**
         * The grader's vocabulary is not the seller's. `label` is the word the
         * route uses and `tag` is the word on the capture strip, so an error
         * that says label sends someone looking for a control that does not
         * exist.
         */
        fun friendlyName(gradingType: String): String = when (gradingType) {
            "label" -> "tag"
            "label_2" -> "second tag"
            else -> gradingType
        }
    }
}

/**
 * US-2815: posts a photo grade to `POST /api/grade/submit`.
 *
 * REFUSES BEFORE UPLOADING. Every check in [validate] is something the route
 * would answer with a 400 or an abstain AFTER the whole body has gone up —
 * which on a phone signal is the slowest possible way to be told no, and in the
 * abstain case costs a charge and a vision call per image before the refund.
 *
 * [validate] and [body] are on the companion because they are pure: a test can
 * read the body it would send without an EdgeApi, which needs a base URL, an
 * OkHttp client and two token callbacks.
 */
class PhotoGradeUploader(private val api: EdgeApi) {

    suspend fun submit(
        images: List<PhotoGradeImage>,
        request: PhotoGradeRequest,
    ): PhotoSubmitResponse {
        validate(images)?.let { throw IllegalArgumentException(it.message) }
        return api.decode(api.postMultipart(PATH, body(images, request)))
    }

    companion object {
        private const val PATH = "/api/grade/submit"

        /** Refuse before uploading. Null means the set is submittable. */
        fun validate(images: List<PhotoGradeImage>): PhotoGradeError? {
            if (images.isEmpty()) return PhotoGradeError.NoImages
            if (images.size > PhotoGradeContract.MAX_IMAGES) {
                return PhotoGradeError.TooManyImages(images.size)
            }
            val missing = PhotoGradeContract.missingRequired(images.map { it.gradingType })
            if (missing.isNotEmpty()) return PhotoGradeError.MissingRequired(missing)
            return null
        }

        /**
         * The ordered parts.
         *
         * ⚠ THE TWO ARRAYS ARE POSITIONAL: the route zips images[i] with
         * image_types[i]. They are appended in ONE loop for that reason. Two
         * separate loops is how a reorder silently mislabels every photo — and
         * a back shot graded as a tag is a WRONG GRADE rather than an error.
         * Nothing fails, the customer is charged, and the certificate is
         * confidently wrong. The iOS uploader carries the same warning above
         * the same loop.
         */
        internal fun body(
            images: List<PhotoGradeImage>,
            request: PhotoGradeRequest,
        ): List<EdgeApi.Part> {
            val parts = mutableListOf<EdgeApi.Part>()
            PhotoGradeFields.fields(request).forEach { (name, value) ->
                parts += EdgeApi.Part.Field(name, value)
            }
            images.forEachIndexed { index, image ->
                parts += EdgeApi.Part.File(
                    name = "images",
                    fileName = "${image.gradingType}-$index.jpg",
                    mimeType = "image/jpeg",
                    bytes = image.jpeg,
                )
                parts += EdgeApi.Part.Field("image_types", image.gradingType)
            }
            return parts
        }
    }
}
