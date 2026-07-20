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
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.gradethread.app.ui.theme.Spacing
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
        Text("AI fill", style = MaterialTheme.typography.titleLarge)

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
                        title = "On-device OCR filled in the gaps",
                        body = "AI couldn't read the tag confidently. The suggestions below " +
                            "came from on-device OCR — double-check before opting in.",
                    )
                }
            }
            if (review.ebayPending) {
                item {
                    Banner(
                        title = "Resolving eBay category…",
                        body = "We're still matching this item to a category. It'll appear on " +
                            "the item shortly — you don't need to wait.",
                    )
                }
            }
            review.conditionSummary?.let { summary ->
                item { SectionHeader("Condition summary") }
                item { Text(summary, style = MaterialTheme.typography.bodyMedium) }
            }

            if (review.applied.isNotEmpty()) {
                item { SectionHeader("AI filled these") }
                items(review.applied, key = { it.field }) { field ->
                    AppliedRow(
                        field = field,
                        checked = field.field in keptApplied,
                        onToggle = { on ->
                            keptApplied = if (on) keptApplied + field.field
                            else keptApplied - field.field
                        },
                    )
                }
                item {
                    Footnote(
                        "Uncheck a field to undo its AI fill — it's restored to what it " +
                            "was before.",
                    )
                }
            }

            if (review.lowConfidence.isNotEmpty()) {
                item { SectionHeader("Suggestions to review") }
                items(review.lowConfidence, key = { it.field }) { entry ->
                    SuggestionRow(
                        entry = entry,
                        checked = entry.field in acceptedLow,
                        onToggle = { on ->
                            acceptedLow = if (on) acceptedLow + entry.field
                            else acceptedLow - entry.field
                        },
                    )
                }
                item {
                    Footnote(
                        "Lower-confidence suggestions weren't applied automatically. Check " +
                            "any you want to add.",
                    )
                }
            }

            if (review.measurements.isNotEmpty()) {
                item { SectionHeader("Measurements (estimated)") }
                item {
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = Spacing.xs),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            if (keepMeasurements) "Keep measurements" else "Measurements removed",
                            modifier = Modifier.weight(1f),
                        )
                        Switch(checked = keepMeasurements, onCheckedChange = { keepMeasurements = it })
                    }
                }
                items(review.measurements.entries.sortedBy { it.key }.toList()) { (name, inches) ->
                    Text(
                        text = "$name: $inches in",
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
        ) { Text("Apply changes") }

        TextButton(onClick = onUndoAll, modifier = Modifier.fillMaxWidth()) {
            Text("Undo AI fill", color = MaterialTheme.colorScheme.error)
        }
        // Cancel dismisses WITHOUT consuming the review (US-1182) — a stray
        // back-press must not silently discard the seller's edits.
        TextButton(onClick = onCancel, modifier = Modifier.fillMaxWidth()) { Text("Cancel") }
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
private fun AppliedRow(
    field: AiExtractReview.AppliedField,
    checked: Boolean,
    onToggle: (Boolean) -> Unit,
) {
    val label = FieldSuggestionEntry(
        field.field,
        FieldSuggestion(field.value, field.confidence, field.source),
    )
    Column(Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth().semantics {
                contentDescription = "${label.displayLabel}: ${field.value}. " +
                    if (checked) "kept." else "will be undone."
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
                    ?.let { "Will revert to \"$it\"" } ?: "Will be cleared",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.tertiary,
                modifier = Modifier.padding(start = Spacing.xl),
            )
        }
    }
}

@Composable
private fun SuggestionRow(
    entry: FieldSuggestionEntry,
    checked: Boolean,
    onToggle: (Boolean) -> Unit,
) {
    val percent = (entry.clampedConfidence * 100).roundToInt()
    Row(
        modifier = Modifier.fillMaxWidth().semantics {
            contentDescription = "${entry.displayLabel}: ${entry.suggestion.value}. " +
                "${entry.sourceLabel}. Confidence $percent percent. " +
                if (checked) "accepted." else "not accepted."
        },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked = checked, onCheckedChange = onToggle)
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(entry.displayLabel, style = MaterialTheme.typography.labelLarge)
                if (entry.isResearch) {
                    Text(
                        "  Identified",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.tertiary,
                    )
                }
                Text(
                    "  $percent%",
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
    confidence >= 0.75 -> Color(0xFF10B981)
    confidence >= 0.5 -> Color(0xFFF59E0B)
    else -> MaterialTheme.colorScheme.error
}
