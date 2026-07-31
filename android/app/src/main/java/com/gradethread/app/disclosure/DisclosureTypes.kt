package com.gradethread.app.disclosure

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * US-1360: defect disclosure — the graded flaws, their photos, and the callouts
 * that mark them.
 */
@Serializable
data class DisclosureData(
    val graded: Boolean = false,
    val item: DisclosureItem? = null,
    val grade: DisclosureGrade? = null,
    val disclosure: DisclosureText? = null,
    val photos: List<DisclosurePhoto> = emptyList(),
)

@Serializable
data class DisclosureItem(
    val id: String = "",
    val title: String? = null,
    val brand: String? = null,
)

@Serializable
data class DisclosureGrade(
    @SerialName("overall_score") val overallScore: Double? = null,
    @SerialName("grade_tier") val gradeTier: String? = null,
    @SerialName("certificate_id") val certificateId: String? = null,
)

@Serializable
data class DisclosureText(
    val plain: String? = null,
    val markdown: String? = null,
    val html: String? = null,
    @SerialName("defect_count") val defectCount: Int? = null,
    @SerialName("has_defects") val hasDefects: Boolean? = null,
)

/** One graded photo and the defects marked on it. */
@Serializable
data class DisclosurePhoto(
    @SerialName("image_type") val imageType: String = "",
    val url: String = "",
    val annotations: List<PhotoAnnotation> = emptyList(),
) {
    /**
     * A role can repeat within one submission, so identity is role + URL.
     * Keying on the role alone would collapse two "detail" shots into one.
     */
    val id: String get() = "$imageType|$url"
}

/**
 * A numbered defect callout.
 *
 * [bbox] is NORMALISED `[x, y, w, h]` in 0..1, or null when the grader couldn't
 * place the defect on the photo. Normalised because the same coordinates have
 * to land in the same spot whether they're drawn on a thumbnail, a full-size
 * composite, or the web — see [DisclosureGeometry].
 */
@Serializable
data class PhotoAnnotation(
    val n: Int = 0,
    val issue: String = "",
    val severity: String = "",
    val location: String? = null,
    val bbox: List<Double>? = null,
) {
    /** Legend-only when the defect has no place on the photo. */
    val isLocalized: Boolean get() = bbox?.size == 4
}

@Serializable
data class SaveAnnotatedResponse(
    val ok: Boolean = false,
    @SerialName("photo_id") val photoId: String? = null,
    @SerialName("photo_url") val photoUrl: String? = null,
)

@Serializable
data class ApplyDisclosureResponse(
    val applied: Boolean = false,
    /**
     * The listing already carried this disclosure. A success, not a no-op
     * failure — and worth saying differently so a seller doesn't push again.
     */
    @SerialName("already_present") val alreadyPresent: Boolean? = null,
)

@Serializable
internal data class AnnotatedPhotoRequest(
    @SerialName("image_type") val imageType: String,
    @SerialName("data_url") val dataUrl: String,
)
