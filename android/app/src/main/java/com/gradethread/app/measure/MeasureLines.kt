package com.gradethread.app.measure

import com.gradethread.app.inventory.MeasurementCatalog
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * US-1576: everything the overlay editor does to its lines, as pure functions.
 *
 * Kept out of the ViewModel so the save semantics — which are the part that
 * writes to a listing a buyer reads — are provable without Hilt, Room, a
 * network or a Compose harness.
 */
object MeasureLines {

    /**
     * The lines to draw, in a stable order.
     *
     * Seeded from the calibration's stored lines, which is where BOTH the
     * extract pass and the seller's own last save land — so reopening the
     * editor shows what was there, not a fresh guess. Ordered by the
     * measurement catalog rather than by map iteration: an editor whose lines
     * reshuffle between openings makes the seller re-find the one they wanted.
     */
    fun seed(calibration: MeasureCalibration): List<MeasureGeometry.Line> {
        val stored = calibration.lines.orEmpty().filterValues { it.isUsable }
        return MeasurementCatalog.ordered(stored.keys).mapNotNull { key ->
            val line = stored[key] ?: return@mapNotNull null
            MeasureGeometry.Line(
                key = key,
                label = line.label.ifBlank { MeasurementCatalog.label(key) },
                e1 = MeasureGeometry.Point(line.e1[0], line.e1[1]),
                e2 = MeasureGeometry.Point(line.e2[0], line.e2[1]),
            )
        }
    }

    /**
     * Move one endpoint, clamped to the image.
     *
     * Clamping is not cosmetic: an endpoint dragged off the photo still maps
     * through the homography and still produces a number, so an un-clamped drag
     * publishes a measurement taken from a point that is not on the garment.
     */
    fun moved(
        lines: List<MeasureGeometry.Line>,
        index: Int,
        end: MeasureGeometry.End,
        to: MeasureGeometry.Point,
        imgW: Double,
        imgH: Double,
    ): List<MeasureGeometry.Line> {
        if (index !in lines.indices) return lines
        val clamped = MeasureGeometry.Point(
            to.x.coerceIn(0.0, imgW),
            to.y.coerceIn(0.0, imgH),
        )
        return lines.mapIndexed { i, line ->
            when {
                i != index -> line
                end == MeasureGeometry.End.E1 -> line.copy(e1 = clamped)
                else -> line.copy(e2 = clamped)
            }
        }
    }

    /** Add a line the auto pass never placed, at its default position. */
    fun withAdded(
        lines: List<MeasureGeometry.Line>,
        key: String,
        imgW: Double,
        imgH: Double,
    ): List<MeasureGeometry.Line> {
        if (lines.any { it.key == key }) return lines
        val (e1, e2) = MeasureGeometry.defaultPlacement(key, imgW, imgH)
        return lines + MeasureGeometry.Line(key, MeasurementCatalog.label(key), e1, e2)
    }

    fun withRemoved(lines: List<MeasureGeometry.Line>, key: String): List<MeasureGeometry.Line> =
        lines.filterNot { it.key == key }

    /** Live inches per key, recomputed from the endpoints through the ruler. */
    fun values(
        lines: List<MeasureGeometry.Line>,
        homography: List<Double>,
    ): Map<String, Double> = lines.associate {
        it.key to MeasureGeometry.inchesBetween(homography, it.e1, it.e2)
    }

    /**
     * The `lines` document to merge into `measure_calibration`.
     *
     * Endpoints go back in ORIGINAL image pixels — the same space they arrived
     * in. Storing display coordinates would make the saved lines depend on the
     * screen that drew them, so the same garment would reopen wrong on a tablet.
     */
    fun storedDocument(
        lines: List<MeasureGeometry.Line>,
        homography: List<Double>,
    ): JsonObject = buildJsonObject {
        for (line in lines) {
            put(
                line.key,
                buildJsonObject {
                    put("e1", JsonArray(listOf(JsonPrimitive(line.e1.x), JsonPrimitive(line.e1.y))))
                    put("e2", JsonArray(listOf(JsonPrimitive(line.e2.x), JsonPrimitive(line.e2.y))))
                    put(
                        "inches",
                        JsonPrimitive(MeasureGeometry.inchesBetween(homography, line.e1, line.e2)),
                    )
                    put("label", JsonPrimitive(line.label))
                },
            )
        }
    }

    /**
     * What the seller changed about a line the MODEL proposed.
     *
     * Only touched keys with a proposal qualify, and that is the whole point:
     * this feeds the measurement accuracy gate (US-1582), which compares what
     * the model said against what a human corrected it to. A line the seller
     * drew themselves has no proposal to be wrong, and a proposal they left
     * alone is agreement, not a correction — sending either would put noise in
     * the one dataset that decides whether the extractor is trusted.
     */
    fun corrections(
        lines: List<MeasureGeometry.Line>,
        proposals: Map<String, ProposedMeasurement>,
        touched: Set<String>,
        homography: List<Double>,
    ): List<MeasureCorrection> {
        val current = values(lines, homography)
        return lines.mapNotNull { line ->
            if (line.key !in touched) return@mapNotNull null
            val proposed = proposals[line.key] ?: return@mapNotNull null
            val final = current[line.key] ?: return@mapNotNull null
            // The server rejects anything outside 0 < v < 200 and fails the
            // WHOLE batch on one bad row, so a nonsense line is dropped here
            // rather than costing the seller every other correction.
            if (!inBand(proposed.inches) || !inBand(final)) return@mapNotNull null
            MeasureCorrection(
                key = line.key,
                proposed = proposed.inches,
                final = final,
                confidence = proposed.confidence,
                flagged = proposed.flagged,
            )
        }
    }

    private fun inBand(v: Double): Boolean = v.isFinite() && v > 0.0 && v < 200.0
}
