package com.gradethread.app.grading

/**
 * US-2815: what `POST /api/grade/submit` requires of a photo grade.
 *
 * The Kotlin twin of iOS `PhotoGradeContract`. Both exist because the route
 * enforces three things a client can get wrong with nothing failing until a
 * customer hits it, and all three are cheaper to check before the upload than
 * after it.
 *
 * Held to the route by `src/test/native-photo-grade-contract-parity.test.ts`,
 * which reads `services/edge-functions/src/lib/image-quality.ts` and
 * `routes/grade.ts` rather than trusting the numbers written here.
 */
object PhotoGradeContract {

    /**
     * The GRADING image vocabulary, which is NOT the FlipDesk one.
     *
     * The tag shot is `label` here and `tag` in [com.gradethread.app.capture.FlipdeskPhotoType]
     * — the exact pair US-2304 found two requirement lists disagreeing over. The
     * server maps grading -> FlipDesk in `gradingImageTypeToPhotoType`; this is
     * the inverse, and it is the direction a client needs.
     */
    fun gradingImageType(flipdeskType: String): String = when (flipdeskType) {
        "tag" -> "label"
        "tag_2" -> "label_2"
        else -> flipdeskType
    }

    /**
     * `REQUIRED_IMAGE_TYPES` in `image-quality.ts`, at severity `block`.
     *
     * A submission missing one of these is CHARGED, runs a Claude Vision call
     * per image, then abstains to needs_photos and refunds. The money comes back
     * and the AI spend does not — which is what US-2304 was about. Checking here
     * means the person is told before they pay rather than after.
     */
    val requiredGradingTypes: List<String> = listOf("front", "back", "label")

    /** Which required shots are absent, in the order the strip shows them. */
    fun missingRequired(present: Collection<String>): List<String> {
        val have = present.toSet()
        return requiredGradingTypes.filter { it !in have }
    }

    /**
     * `MAX_IMAGES_PER_SUBMISSION` on the route, which is `IMAGE_TYPES.length`.
     *
     * The route also rejects DUPLICATE types, so the real rule is one of each
     * kind rather than fourteen photos. The cap exists because the pipeline
     * issues one vision call PER image while billing a single grade, so an
     * uncapped count is a direct AI-cost multiplier.
     */
    const val MAX_IMAGES = 14
}
