package com.gradethread.app.disclosure

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.util.Base64
import java.io.ByteArrayOutputStream

/**
 * US-1360: burns the callouts into the photo.
 *
 * The composite is what a buyer eventually sees, so the drawing follows
 * [DisclosureGeometry] exactly rather than eyeballing offsets — the preview on
 * screen and the PNG that gets uploaded are the same arithmetic, which is the
 * only way "re-rendered consistently" can be true.
 */
object DisclosureRenderer {

    private const val BOX_STROKE = 4f
    private const val BADGE_RADIUS = 15f
    private const val BADGE_TEXT_SIZE = 20f
    private const val LEGEND_TEXT_SIZE = 17f

    /** PNG quality is ignored by the encoder, but the format is not negotiable —
     *  the server accepts image/png only. */
    private const val PNG_QUALITY = 100

    /**
     * Draw [photo]'s annotations over [source].
     *
     * Localised defects get a numbered box; unlocalised ones still get a legend
     * line, because "we found this but can't point at it" is information a buyer
     * is entitled to. The bitmap is caller-owned; this returns a new one.
     */
    fun render(source: Bitmap, photo: DisclosurePhoto): Bitmap {
        val annotations = photo.annotations.sortedBy { it.n }
        val canvasSize = DisclosureGeometry.canvasSize(source.width, source.height)
        val composite = DisclosureGeometry.compositeSize(
            source.width,
            source.height,
            annotations.size,
        )
        val bitmap = Bitmap.createBitmap(
            composite.width.toInt().coerceAtLeast(1),
            composite.height.toInt().coerceAtLeast(1),
            Bitmap.Config.ARGB_8888,
        )
        val canvas = Canvas(bitmap)
        canvas.drawColor(Color.WHITE)

        val scaled = Bitmap.createScaledBitmap(
            source,
            canvasSize.width.toInt().coerceAtLeast(1),
            canvasSize.height.toInt().coerceAtLeast(1),
            true,
        )
        canvas.drawBitmap(scaled, 0f, 0f, null)
        if (scaled !== source) scaled.recycle()

        val boxPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = BOX_STROKE
        }
        val badgePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
        val badgeTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            textSize = BADGE_TEXT_SIZE
            typeface = Typeface.DEFAULT_BOLD
            textAlign = Paint.Align.CENTER
        }

        for (annotation in annotations) {
            val rect = DisclosureGeometry.scaledRect(annotation.bbox, canvasSize) ?: continue
            val color = DisclosureGeometry.SeverityColor.of(annotation.severity)
            boxPaint.color = color
            canvas.drawRect(rect.left, rect.top, rect.right, rect.bottom, boxPaint)

            // The badge sits INSIDE the top-left corner, so a box at the very
            // edge of the photo doesn't push its number off the canvas.
            val badgeX = (rect.left + BADGE_RADIUS).coerceIn(BADGE_RADIUS, canvasSize.width - BADGE_RADIUS)
            val badgeY = (rect.top + BADGE_RADIUS).coerceIn(BADGE_RADIUS, canvasSize.height - BADGE_RADIUS)
            badgePaint.color = color
            canvas.drawCircle(badgeX, badgeY, BADGE_RADIUS, badgePaint)
            canvas.drawText(
                annotation.n.toString(),
                badgeX,
                badgeY + BADGE_TEXT_SIZE / 3,
                badgeTextPaint,
            )
        }

        val legendPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            textSize = LEGEND_TEXT_SIZE
            color = Color.BLACK
        }
        var y = canvasSize.height + DisclosureGeometry.LEGEND_PADDING +
            DisclosureGeometry.LEGEND_LINE_HEIGHT / 1.5f
        for (annotation in annotations) {
            legendPaint.color = DisclosureGeometry.SeverityColor.of(annotation.severity)
            canvas.drawCircle(
                DisclosureGeometry.LEGEND_PADDING + 6f,
                y - LEGEND_TEXT_SIZE / 3,
                6f,
                legendPaint,
            )
            legendPaint.color = Color.BLACK
            canvas.drawText(
                DisclosureGeometry.legendLine(annotation),
                DisclosureGeometry.LEGEND_PADDING + 20f,
                y,
                legendPaint,
            )
            y += DisclosureGeometry.LEGEND_LINE_HEIGHT
        }
        return bitmap
    }

    /**
     * The `data:image/png;base64,…` string the endpoint takes.
     *
     * PNG because the server validates the real format by magic bytes and
     * accepts nothing else — a JPEG behind a png prefix is rejected, which is
     * the point of that check.
     */
    fun toDataUrl(bitmap: Bitmap): String {
        val stream = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, PNG_QUALITY, stream)
        val encoded = Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
        return "data:image/png;base64,$encoded"
    }
}
