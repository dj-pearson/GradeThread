package com.gradethread.app.ai

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.statusAmber
import com.gradethread.app.ui.theme.statusEmerald
import kotlin.math.roundToInt

/**
 * US-1334: the AI fill review sheet (iOS `AIFillReviewSheet`).
 *
 * The defaults encode the trust model: high-confidence fields are already
 * applied and shown CHECKED, low-confidence ones are shown UNCHECKED and
 * require an explicit opt-in. Nothing below the bar is ever written without
 * the seller ticking it.
 */
@Composable
fun AiFillReviewSheet(
    review: AiExtractReview.Review,
    onApply: (keptApplied: Set<String>, acceptedLow: Set<String>, keepMeasurements: Boolean) -> Unit,
    onUndoAll: () -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // Applied fields start kept; low-confidence start rejected.
    var keptApplied by remember(review) {
        mutableStateOf(review.applied.map { it.field }.toSet())
    }
    var acceptedLow by remember(review) { mutableStateOf(emptySet<String>()) }
    var keepMeasurements by remember(review) { mutableStateOf(review.measurementsApplied) }

    Column(modifier.fillMaxWidth().padding(Spacing.md)) {
        Text(stringResource(R.string.aifill_ai_fill), style = MaterialTheme.typography.titleLarge)

        review.quotaLabel?.let { quota ->
            Text(
                text = quota,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = Spacing.xxs),
            )
        }

        LazyColumn(Modifier.weight(1f, fill = false)) {
            if (review.usedLiveTextFallback) {
                item {
                    Banner(
                        title = stringResource(R.string.aifill_device_ocr_filled_gaps),
                        body = stringResource(R.string.aifill_low_confidence_body),
                    )
                }
            }
            if (review.ebayPending) {
                item {
                    Banner(
                        title = stringResource(R.string.aifill_resolving_ebay_category),
                        body = stringResource(R.string.aifill_category_pending_body),
                    )
                }
            }
            review.conditionSummary?.let { summary ->
                item { SectionHeader(stringResource(R.string.aifill_condition_summary)) }
                item { Text(summary, style = MaterialTheme.typography.bodyMedium) }
            }

            if (review.applied.isNotEmpty()) {
                item { SectionHeader(stringResource(R.string.aifill_ai_filled_these)) }
                items(review.applied, key = { it.field }) { field ->
                    AppliedRow(
                        field = field,
                        checked = field.field in keptApplied,
                        onToggle = { on ->
                            keptApplied = if (on) {
                                keptApplied + field.field
                            } else {
                                keptApplied - field.field
                            }
                        },
                    )
                }
                item {
                    Footnote(
                        stringResource(R.string.aifill_uncheck_hint),
                    )
                }
            }

            if (review.lowConfidence.isNotEmpty()) {
                item { SectionHeader(stringResource(R.string.aifill_suggestions_review)) }
                items(review.lowConfidence, key = { it.field }) { entry ->
                    SuggestionRow(
                        entry = entry,
                        checked = entry.field in acceptedLow,
                        onToggle = { on ->
                            acceptedLow = if (on) {
                                acceptedLow + entry.field
                            } else {
                                acceptedLow - entry.field
                            }
                        },
                    )
                }
                item {
                    Footnote(
                        stringResource(R.string.aifill_low_confidence_hint),
                    )
                }
            }

            if (review.measurements.isNotEmpty()) {
                item { SectionHeader(stringResource(R.string.aifill_measurements_estimated)) }
                item {
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = Spacing.xs),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            stringResource(
                                if (keepMeasurements) {
                                    R.string.aifill_keep_measurements
                                } else {
                                    R.string.aifill_measurements_removed
                                },
                            ),
                            modifier = Modifier.weight(1f),
                        )
                        Switch(checked = keepMeasurements, onCheckedChange = { keepMeasurements = it })
                    }
                }
                items(review.measurements.entries.sortedBy { it.key }.toList()) { (name, inches) ->
                    Text(
                        text = stringResource(R.string.aifill_measurement, name, inches),
                        style = MaterialTheme.typography.bodySmall,
                        // Dimmed rather than hidden when off, so the seller can
                        // still see what they're discarding.
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(
                            alpha = if (keepMeasurements) 1f else 0.4f,
                        ),
                    )
                }
            }
        }

        Button(
            onClick = { onApply(keptApplied, acceptedLow, keepMeasurements) },
            modifier = Modifier.fillMaxWidth().padding(top = Spacing.md),
        ) { Text(stringResource(R.string.aifill_apply_changes)) }

        TextButton(onClick = onUndoAll, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.aifill_undo_ai_fill), color = MaterialTheme.colorScheme.error)
        }
        // Cancel dismisses WITHOUT consuming the review (US-1182) — a stray
        // back-press must not silently discard the seller's edits.
        TextButton(onClick = onCancel, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.aifill_cancel))
        }
    }
}

@Composable
private fun SectionHeader(text: String) {
    Column {
        HorizontalDivider(Modifier.padding(vertical = Spacing.xs))
        Text(
            text = text,
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun Footnote(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(top = Spacing.xxs, bottom = Spacing.xs),
    )
}

@Composable
private fun Banner(title: String, body: String) {
    Column(Modifier.fillMaxWidth().padding(vertical = Spacing.xs)) {
        Text(title, style = MaterialTheme.typography.labelLarge)
        Text(
            body,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun AppliedRow(field: AiExtractReview.AppliedField, checked: Boolean, onToggle: (Boolean) -> Unit) {
    val label = FieldSuggestionEntry(
        field.field,
        FieldSuggestion(field.value, field.confidence, field.source),
    )
    // Resolved out here: `semantics { }` is not a composable scope, so a
    // stringResource call inside it does not compile.
    val spoken = stringResource(
        R.string.aifill_field_spoken,
        label.displayLabel,
        field.value,
        stringResource(if (checked) R.string.aifill_kept else R.string.aifill_will_undo),
    )
    Column(Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth().semantics {
                contentDescription = spoken
            },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Checkbox(checked = checked, onCheckedChange = onToggle)
            Column(Modifier.weight(1f)) {
                Text(label.displayLabel, style = MaterialTheme.typography.labelLarge)
                Text(field.value, style = MaterialTheme.typography.bodyMedium)
                Text(
                    label.sourceLabel,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (!checked) {
            // Say exactly what undoing restores — "it'll revert" alone leaves
            // the seller guessing whether they lose their own earlier edit.
            Text(
                text = field.previousValue?.takeIf { it.isNotBlank() }
                    ?.let { stringResource(R.string.aifill_will_revert, it) }
                    ?: stringResource(R.string.aifill_will_clear),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.tertiary,
                modifier = Modifier.padding(start = Spacing.xl),
            )
        }
    }
}

@Composable
private fun SuggestionRow(entry: FieldSuggestionEntry, checked: Boolean, onToggle: (Boolean) -> Unit) {
    val percent = (entry.clampedConfidence * 100).roundToInt()
    // See AppliedRow: `semantics { }` is not a composable scope.
    val spoken = stringResource(
        R.string.aifill_suggestion_spoken,
        entry.displayLabel,
        entry.suggestion.value,
        entry.sourceLabel,
        percent,
        stringResource(
            if (checked) R.string.aifill_accepted else R.string.aifill_not_accepted,
        ),
    )
    Row(
        modifier = Modifier.fillMaxWidth().semantics {
            contentDescription = spoken
        },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked = checked, onCheckedChange = onToggle)
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(entry.displayLabel, style = MaterialTheme.typography.labelLarge)
                if (entry.isResearch) {
                    Text(
                        stringResource(R.string.aifill_identified),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.tertiary,
                    )
                }
                Text(
                    stringResource(R.string.aifill_percent, percent),
                    style = MaterialTheme.typography.labelSmall,
                    color = confidenceColor(entry.clampedConfidence),
                )
            }
            Text(entry.suggestion.value, style = MaterialTheme.typography.bodyMedium)
            Text(
                entry.sourceLabel,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            ConfidenceBar(entry.clampedConfidence)
        }
    }
}

@Composable
private fun ConfidenceBar(confidence: Double) {
    val track = MaterialTheme.colorScheme.surfaceVariant
    val fill = confidenceColor(confidence)
    Box(
        Modifier.width(90.dp).height(4.dp)
            .background(track, RoundedCornerShape(2.dp)),
    ) {
        Box(
            Modifier
                // Already clamped by the caller, so this can't go negative.
                .width((90 * confidence).dp)
                .height(4.dp)
                .background(fill, RoundedCornerShape(2.dp)),
        )
    }
}

/** High / Medium / Low, matching the iOS GradeScale confidence bands. */
@Composable
private fun confidenceColor(confidence: Double): Color = when {
    confidence >= 0.75 -> statusEmerald()
    confidence >= 0.5 -> statusAmber()
    else -> MaterialTheme.colorScheme.error
}
