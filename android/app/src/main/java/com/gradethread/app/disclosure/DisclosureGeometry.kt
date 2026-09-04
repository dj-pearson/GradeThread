package com.gradethread.app.disclosure

import kotlin.math.floor

/**
 * US-1360: where a defect callout lands on the photo.
 *
 * Pure, and mirrors the web `annotated-photo.tsx` constant for constant. That
 * shared arithmetic IS the feature: annotations are stored normalised, so a box
 * drawn over the preview on a phone and the same box burned into the saved PNG
 * (and the one the web renders) must land on the same thread. Any divergence
 * here puts a marker next to a flaw instead of on it, in a photo that goes to a
 * buyer as evidence.
 */
object DisclosureGeometry {

    /** The composite's long edge. Bigger doesn't help; it just bloats the PNG. */
    const val MAX_CANVAS_WIDTH = 900f

    const val LEGEND_LINE_HEIGHT = 26f
    const val LEGEND_PADDING = 14f

    data class Size(val width: Float, val height: Float) {
        val isEmpty: Boolean get() = width <= 0f || height <= 0f
    }

    data class Rect(val left: Float, val top: Float, val width: Float, val height: Float) {
        val right: Float get() = left + width
        val bottom: Float get() = top + height
    }

    /**
     * The photo's drawn size: scaled DOWN to the cap, never up, aspect kept.
     *
     * Never up because upscaling a small flaw photo makes a blurrier image, not
     * a clearer one — and this photo's whole job is showing a buyer the flaw.
     */
    fun canvasSize(imageWidth: Int, imageHeight: Int): Size {
        if (imageWidth <= 0 || imageHeight <= 0) return Size(0f, 0f)
        val width = minOf(imageWidth.toFloat(), MAX_CANVAS_WIDTH)
        val scale = width / imageWidth
        return Size(width, floor(imageHeight * scale))
    }

    /**
     * A normalised `[x, y, w, h]` box in pixels, or null when malformed.
     *
     * Null rather than a guessed rectangle: a callout drawn from bad
     * coordinates points at the wrong part of the garment, which is worse than
     * no box at all — the legend still names the defect.
     */
    fun scaledRect(bbox: List<Double>?, size: Size): Rect? {
        if (bbox == null || bbox.size != 4) return null
        if (size.isEmpty) return null
        if (bbox.any { !it.isFinite() }) return null
        return Rect(
            left = (bbox[0] * size.width).toFloat(),
            top = (bbox[1] * size.height).toFloat(),
            width = (bbox[2] * size.width).toFloat(),
            height = (bbox[3] * size.height).toFloat(),
        )
    }

    /** The legend strip under the photo. Zero when there's nothing to list. */
    fun legendHeight(annotationCount: Int): Float =
        if (annotationCount <= 0) 0f else LEGEND_PADDING * 2 + annotationCount * LEGEND_LINE_HEIGHT

    /** Photo plus legend. */
    fun compositeSize(imageWidth: Int, imageHeight: Int, annotationCount: Int): Size {
        val canvas = canvasSize(imageWidth, imageHeight)
        return Size(canvas.width, canvas.height + legendHeight(annotationCount))
    }

    /**
     * Severity → colour, matching the web's SEVERITY_COLOR.
     *
     * ⚠ US-3010: these stay raw and fixed. DisclosureRenderer paints them into
     * a BITMAP that is exported and shown to buyers, so they must match the
     * web's values rather than the reader's theme - the same annotation has to
     * be the same colour wherever the image is opened.
     */
    object SeverityColor {
        const val MAJOR = 0xFFF03D5F.toInt()
        const val MODERATE = 0xFFF59E0B.toInt()
        const val MINOR = 0xFFEAB308.toInt()

        /** Unknown severities fall back to the minor tone rather than vanishing. */
        fun of(severity: String): Int = when (severity.lowercase()) {
            "major" -> MAJOR
            "moderate" -> MODERATE
            else -> MINOR
        }
    }

    /** "3. Pilling on the left cuff (minor)" — the legend line for a callout. */
    fun legendLine(annotation: PhotoAnnotation): String {
        val where = annotation.location?.takeIf { it.isNotBlank() }?.let { " — $it" }.orEmpty()
        val severity = annotation.severity.takeIf { it.isNotBlank() }?.let { " ($it)" }.orEmpty()
        return "${annotation.n}. ${annotation.issue}$where$severity"
    }
}
