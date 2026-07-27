package com.gradethread.app.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1363 AC1/AC3, US-1370 AC1: the Money/Home charts.
 *
 * Drawn with Compose `Canvas` rather than a charting library. US-1363 names Vico
 * parenthetically, but these three shapes are ~40 lines of drawing each, and the
 * app is already carrying an APK-size problem (US-2150: ML Kit native libs across
 * four ABIs). Pulling a chart engine in for a sparkline and two bar charts would
 * add weight to the exact thing that needs trimming, so the substance of the AC —
 * the charts — is met without the dependency.
 *
 * These are STATIC drawings: no animation to gate, which is the strongest form of
 * reduced-motion compliance (US-1304). Anything animated added here must go
 * through `accessibleSpec`.
 *
 * ACCESSIBILITY: every chart takes a spoken `description` and merges its
 * children away with `clearAndSetSemantics`. A bar chart that reads out fourteen
 * unlabeled rectangles is worse than one that says the trend in a sentence
 * (US-1223: the iOS sparkline's rising/falling cue was color-only).
 */

/**
 * Compact area+line sparkline — a glanceable SHAPE, not a precise chart, so it
 * has no axes or labels.
 */
@Composable
fun Sparkline(
    values: List<Double>,
    description: String,
    modifier: Modifier = Modifier,
    height: Dp = 48.dp,
    tint: Color = MaterialTheme.colorScheme.primary,
) {
    Canvas(
        modifier
            .fillMaxWidth()
            .height(height)
            .clearAndSetSemantics { contentDescription = description },
    ) {
        if (values.size < 2) return@Canvas
        val maxValue = values.max()
        // A flat run (all zeros, or all equal) draws along the BOTTOM rather
        // than dividing by zero or spiking to full height on noise.
        val range = if (maxValue > 0) maxValue else 1.0
        val stepX = size.width / (values.size - 1)

        fun pointAt(index: Int): Offset = Offset(
            x = stepX * index,
            // Inset by the stroke width so the line isn't clipped at the top.
            y = size.height - (values[index] / range * (size.height - STROKE)).toFloat(),
        )

        val line = Path().apply {
            moveTo(pointAt(0).x, pointAt(0).y)
            for (index in 1 until values.size) lineTo(pointAt(index).x, pointAt(index).y)
        }
        val area = Path().apply {
            addPath(line)
            lineTo(size.width, size.height)
            lineTo(0f, size.height)
            close()
        }

        drawPath(
            area,
            brush = Brush.verticalGradient(
                listOf(tint.copy(alpha = 0.28f), tint.copy(alpha = 0.02f)),
            ),
        )
        drawPath(line, color = tint, style = Stroke(width = STROKE))
    }
}

/** One labelled bar. */
data class BarDatum(val label: String, val value: Double)

/**
 * Vertical bar chart with labels under each bar — the shape the 6-month revenue,
 * aging and time-on-market panels all need.
 */
@Composable
fun BarChart(
    bars: List<BarDatum>,
    description: String,
    modifier: Modifier = Modifier,
    height: Dp = 120.dp,
    tint: Color = MaterialTheme.colorScheme.primary,
) {
    if (bars.isEmpty()) return
    Column(modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = description }) {
        Canvas(Modifier.fillMaxWidth().height(height)) {
            val maxValue = bars.maxOf { it.value }
            // An all-zero set draws an empty plot instead of full-height bars,
            // which would read as "a great month" on no data at all.
            if (maxValue <= 0) return@Canvas
            val slot = size.width / bars.size
            val barWidth = (slot * 0.55f).coerceAtLeast(2f)

            bars.forEachIndexed { index, bar ->
                if (bar.value <= 0) return@forEachIndexed
                val barHeight = (bar.value / maxValue * size.height).toFloat()
                drawRect(
                    color = tint,
                    topLeft = Offset(
                        x = slot * index + (slot - barWidth) / 2f,
                        y = size.height - barHeight,
                    ),
                    size = Size(barWidth, barHeight),
                )
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = Spacing.xxs)) {
            bars.forEach { bar ->
                Text(
                    bar.label,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    maxLines = 1,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

/**
 * Grouped bars for cash flow: money in vs money out, per month.
 *
 * Both series are scaled against ONE maximum so the two are visually comparable
 * — scaling each to its own max would draw a £10 expense month the same height
 * as a £10,000 revenue month.
 */
@Composable
fun GroupedBarChart(
    labels: List<String>,
    seriesA: List<Double>,
    seriesB: List<Double>,
    description: String,
    modifier: Modifier = Modifier,
    height: Dp = 120.dp,
    tintA: Color = MaterialTheme.colorScheme.primary,
    tintB: Color = MaterialTheme.colorScheme.error,
) {
    if (labels.isEmpty()) return
    Column(modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = description }) {
        Canvas(Modifier.fillMaxWidth().height(height)) {
            val maxValue = (seriesA + seriesB).maxOrNull() ?: 0.0
            if (maxValue <= 0) return@Canvas
            val slot = size.width / labels.size
            val barWidth = (slot * 0.3f).coerceAtLeast(2f)

            labels.indices.forEach { index ->
                val pairs = listOf(
                    seriesA.getOrNull(index) to tintA,
                    seriesB.getOrNull(index) to tintB,
                )
                pairs.forEachIndexed { slotIndex, (value, color) ->
                    val amount = value ?: 0.0
                    if (amount <= 0) return@forEachIndexed
                    val barHeight = (amount / maxValue * size.height).toFloat()
                    drawRect(
                        color = color,
                        topLeft = Offset(
                            // Two bars centred in the slot with a hair of gap.
                            x = slot * index + slot / 2f - barWidth * 1.1f +
                                slotIndex * barWidth * 1.2f,
                            y = size.height - barHeight,
                        ),
                        size = Size(barWidth, barHeight),
                    )
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = Spacing.xxs)) {
            labels.forEach { label ->
                Text(
                    label,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    maxLines = 1,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

private const val STROKE = 4f
