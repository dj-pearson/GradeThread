package com.gradethread.app.measure

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AssistChip
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import com.gradethread.app.R
import com.gradethread.app.inventory.MeasurementCatalog
import com.gradethread.app.ui.theme.BrandPalette
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1576: measure a garment from the MeasureCard photo.
 *
 * A sheet rather than a route, mirroring iOS: the seller is mid-edit on the
 * canvas, the values land back in the same draft, and one canvas save persists
 * them — so navigating away and back would be a second place to lose work.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MeasurementPhotoEditorSheet(
    itemId: String,
    onApply: (Map<String, Double>) -> Unit,
    onDismiss: () -> Unit,
    viewModel: MeasurementEditorViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    LaunchedEffect(itemId) { viewModel.bind(itemId) }
    // Closing on the SAVED flag rather than in the click handler: the sheet
    // must not disappear while the write is still in flight, or a failure has
    // nowhere left to be reported.
    // US-2978: the callback is not among this effect's keys, so the block
    // carries whichever closure existed when the key last changed. Read it
    // through rememberUpdatedState rather than adding it to the keys —
    // restarting on a lambda that changes every recomposition would re-run
    // the effect for no reason.
    val currentOnDismiss by rememberUpdatedState(onDismiss)
    LaunchedEffect(state.saved) { if (state.saved) currentOnDismiss() }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    ) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = Spacing.md, vertical = Spacing.xs),
            verticalArrangement = Arrangement.spacedBy(Spacing.xs),
        ) {
            Text(
                stringResource(R.string.measure_editor_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )

            when {
                state.loading -> CircularProgressIndicator(Modifier.size(24.dp))
                !state.hasPhoto -> Text(
                    stringResource(R.string.measure_editor_no_photo),
                    style = MaterialTheme.typography.bodyMedium,
                )
                else -> EditorBody(state, viewModel, onApply)
            }

            state.errorMessage?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                TextButton(onClick = viewModel::dismissError) {
                    Text(stringResource(R.string.common_dismiss))
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun EditorBody(
    state: MeasurementEditorViewModel.State,
    viewModel: MeasurementEditorViewModel,
    onApply: (Map<String, Double>) -> Unit,
) {
    state.quality?.let { failure ->
        // The server's own sentence, verbatim: it names WHICH of the five faults
        // this photo has, which nothing on the device can work out. A generic
        // "couldn't read the card" would send the seller round the same loop.
        Column(verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
            Text(
                failure.guidance,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
            )
            Text(
                stringResource(R.string.measure_editor_retake_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            BrandSecondaryButton(
                text = stringResource(R.string.measure_editor_try_again),
                enabled = state.busy == null,
            ) { viewModel.calibrate(force = true) }
        }
        return
    }

    if (!state.isCalibrated) {
        CircularProgressIndicator(Modifier.size(24.dp))
        return
    }

    if (!state.hasImageSize) {
        // Without the stored dimensions every endpoint maps to the same display
        // point, so the overlay would collapse into the corner and read as a
        // broken editor rather than a photo whose size we never recorded.
        Text(
            stringResource(R.string.measure_editor_no_dimensions),
            style = MaterialTheme.typography.bodyMedium,
        )
        return
    }

    MeasureCanvas(state, viewModel)

    val values = state.values
    FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
        state.lines.forEach { line ->
            InputChip(
                selected = state.isFlagged(line.key),
                onClick = { viewModel.removeLine(line.key) },
                label = {
                    Text(
                        stringResource(
                            R.string.measure_editor_line_chip,
                            line.label,
                            MeasureGeometry.formatQuarter(values[line.key] ?: 0.0),
                        ),
                    )
                },
            )
        }
    }

    val addable = remember(state.lines) {
        MeasurementCatalog.specs.map { it.key }.filter { key -> state.lines.none { it.key == key } }
    }
    if (addable.isNotEmpty()) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
            addable.forEach { key ->
                AssistChip(
                    onClick = { viewModel.addLine(key) },
                    label = { Text(stringResource(R.string.measure_editor_add_line, MeasurementCatalog.label(key))) },
                )
            }
        }
    }

    Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        BrandSecondaryButton(
            text = if (state.busy == MeasurementEditorViewModel.Busy.EXTRACTING) {
                stringResource(R.string.measure_editor_auto_running)
            } else {
                stringResource(R.string.measure_editor_auto)
            },
            enabled = state.busy == null,
            modifier = Modifier.weight(1f),
        ) { viewModel.autoMeasure() }
        BrandPrimaryButton(
            text = stringResource(R.string.common_save),
            enabled = state.busy == null,
            modifier = Modifier.weight(1f),
        ) { viewModel.save(onApply) }
    }
}

/**
 * The photo with the lines drawn over it.
 *
 * Endpoints live in ORIGINAL image pixels and are multiplied by [scale] to
 * reach the display, never the other way round — the stored geometry has to be
 * independent of the screen that drew it, or the same garment reopens wrong on
 * a tablet.
 */
@Composable
private fun MeasureCanvas(state: MeasurementEditorViewModel.State, viewModel: MeasurementEditorViewModel) {
    val density = LocalDensity.current
    val textMeasurer = rememberTextMeasurer()
    val maxHeightDp = 360.dp
    var canvasWidthPx by remember { mutableStateOf(0f) }

    val photo = state.photo
    val spoken = pluralStringResource(R.plurals.measure_editor_canvas_a11y, state.lines.size, state.lines.size)

    Box(
        Modifier
            .fillMaxWidth()
            .height(maxHeightDp)
            .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(12.dp))
            .semantics { contentDescription = spoken },
        contentAlignment = Alignment.Center,
    ) {
        AsyncImage(
            model = photo?.photoUrl?.takeIf { it.isNotBlank() } ?: photo?.thumbnailUrl,
            contentDescription = null,
            contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxWidth().height(maxHeightDp),
        )

        androidx.compose.foundation.Canvas(
            modifier = Modifier
                .fillMaxWidth()
                .height(maxHeightDp)
                .pointerInput(state.lines.size, state.imageWidth, state.imageHeight, canvasWidthPx) {
                    var grabbed: MeasureGeometry.EndpointHit? = null
                    detectDragGestures(
                        onDragStart = { offset ->
                            val scale = displayScale(
                                state,
                                canvasWidthPx,
                                with(density) { maxHeightDp.toPx() },
                            )
                            grabbed = MeasureGeometry.hitEndpoint(
                                lines = state.lines,
                                displayPoint = MeasureGeometry.Point(offset.x.toDouble(), offset.y.toDouble()),
                                scale = scale,
                                radius = with(density) { MeasureGeometry.TOUCH_RADIUS_DP.dp.toPx() }.toDouble(),
                            )
                        },
                        onDragEnd = { grabbed = null },
                        onDragCancel = { grabbed = null },
                        onDrag = { change, _ ->
                            val hit = grabbed ?: return@detectDragGestures
                            change.consume()
                            val scale = displayScale(
                                state,
                                canvasWidthPx,
                                with(density) { maxHeightDp.toPx() },
                            )
                            if (scale <= 0.0) return@detectDragGestures
                            viewModel.moveEndpoint(
                                index = hit.lineIndex,
                                end = hit.end,
                                to = MeasureGeometry.Point(
                                    change.position.x / scale,
                                    change.position.y / scale,
                                ),
                            )
                        },
                    )
                },
        ) {
            canvasWidthPx = size.width
            val scale = MeasureGeometry.fitScale(
                state.imageWidth,
                state.imageHeight,
                size.width.toDouble(),
                size.height.toDouble(),
            ).toFloat()
            if (scale <= 0f) return@Canvas

            val values = MeasureLines.values(state.lines, state.homography)
            val haloWidth = with(density) { 5.dp.toPx() }
            val strokeWidth = with(density) { 2.5.dp.toPx() }
            val dotRadius = with(density) { 7.dp.toPx() }

            state.lines.forEachIndexed { _, line ->
                val a = Offset(line.e1.x.toFloat() * scale, line.e1.y.toFloat() * scale)
                val b = Offset(line.e2.x.toFloat() * scale, line.e2.y.toFloat() * scale)
                // Amber ONLY while the model's flag stands. The moment the
                // seller moves the line it is their number, and colouring their
                // own correction as suspect would be telling them they are
                // wrong about their own garment.
                val color = if (state.isFlagged(line.key)) BrandPalette.Amber else BrandPalette.Navy

                // Halo first: a navy line on a dark garment is invisible, and
                // the seller cannot drag an endpoint they cannot find.
                drawLine(Color.White, a, b, strokeWidth = haloWidth)
                drawLine(color, a, b, strokeWidth = strokeWidth)
                for (point in listOf(a, b)) {
                    drawCircle(Color.White, radius = dotRadius, center = point)
                    drawCircle(color, radius = dotRadius, center = point, style = Stroke(strokeWidth))
                }

                val text = MeasureGeometry.formatQuarter(values[line.key] ?: 0.0)
                val layout = textMeasurer.measure(text, TextStyle(fontSize = 12.sp, color = color))
                drawText(
                    textLayoutResult = layout,
                    topLeft = Offset(
                        (a.x + b.x) / 2f - layout.size.width / 2f,
                        (a.y + b.y) / 2f - layout.size.height - dotRadius,
                    ),
                )
            }
        }
    }
}

/** The same fit the Canvas draws with, for hit-testing before the first draw. */
private fun displayScale(state: MeasurementEditorViewModel.State, widthPx: Float, heightPx: Float): Double =
    MeasureGeometry.fitScale(
        state.imageWidth,
        state.imageHeight,
        widthPx.toDouble(),
        heightPx.toDouble(),
    )
