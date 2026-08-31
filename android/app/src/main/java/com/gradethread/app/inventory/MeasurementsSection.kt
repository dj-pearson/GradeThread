package com.gradethread.app.inventory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AssistChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import com.gradethread.app.R
import com.gradethread.app.ui.text
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1345: editable measurements.
 *
 * The story calls this out explicitly — iOS shipped these READ-ONLY, so a
 * seller could see a measurement the AI had estimated but not correct it. A
 * wrong measurement a buyer relies on is worse than no measurement, so being
 * able to fix it is the point of the story.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun MeasurementsSection(
    measurements: Map<String, Double>,
    category: String?,
    onSet: (String, Double?) -> Unit,
    modifier: Modifier = Modifier,
) {
    // Keys with a value, plus any the seller has opened this session — so a
    // freshly added row doesn't vanish the moment the field is cleared.
    var opened by remember(category) { mutableStateOf(emptySet<String>()) }
    val shown = remember(measurements, opened) {
        MeasurementCatalog.ordered(measurements.keys + opened)
    }
    val suggestions = remember(category, shown) {
        MeasurementCatalog.suggestedKeys(category).filter { it !in shown }
    }

    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
        Text(
            stringResource(R.string.measure_title),
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            stringResource(R.string.measure_subtitle),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        shown.forEach { key ->
            MeasurementField(
                key = key,
                value = measurements[key],
                onSet = { onSet(key, it) },
                onRemove = {
                    opened = opened - key
                    onSet(key, null)
                },
            )
        }

        if (suggestions.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
                suggestions.forEach { key ->
                    AssistChip(
                        onClick = { opened = opened + key },
                        label = { Text("+ ${MeasurementCatalog.display(key).text()}") },
                    )
                }
            }
        }
    }
}

@Composable
private fun MeasurementField(key: String, value: Double?, onSet: (Double?) -> Unit, onRemove: () -> Unit) {
    // The field holds TEXT, not the parsed number: re-formatting mid-typing
    // would fight the seller over a half-entered "18." (and, in a
    // comma-decimal locale, over "18,").
    var text by remember(key, value) { mutableStateOf(MeasurementCatalog.editableString(value)) }
    val spec = MeasurementCatalog.kind(key)

    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(
            value = text,
            onValueChange = { entered ->
                text = entered
                // A blank field clears the key rather than storing 0 — zero is
                // a measurement, and a listing claiming a 0" chest is worse
                // than one claiming nothing.
                onSet(MeasurementCatalog.parse(entered))
            },
            label = { Text("${MeasurementCatalog.display(key).text()} (${spec.unit})") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.weight(1f),
        )
        TextButton(onClick = onRemove) { Text(stringResource(R.string.common_remove)) }
    }
}

/**
 * US-1345 AC2: the AI size estimate.
 *
 * Shown as a SUGGESTION with its confidence, never auto-applied: it is a guess
 * from photographs, and silently overwriting a size the seller read off the
 * tag would be the wrong trade every time.
 */
@Composable
fun SizeEstimateCard(
    estimate: SizeEstimate?,
    busy: Boolean,
    errorMessage: String?,
    onEstimate: () -> Unit,
    onApply: (String) -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
        if (estimate == null) {
            BrandSecondaryButton(
                text = if (busy) {
                    stringResource(R.string.measure_estimating)
                } else {
                    stringResource(R.string.measure_estimate_cta)
                },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
            ) { onEstimate() }
        } else if (!estimate.isUsable) {
            // An empty size is a real answer. Applying it would clear whatever
            // the seller already had.
            Text(
                stringResource(R.string.measure_estimate_unusable),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_dismiss)) }
        } else {
            Text(
                // Built by nesting format strings rather than concatenating:
                // the separator and the order of size / gender / confidence are
                // the translator's to move, and a chain of `+` fixes both.
                stringResource(
                    R.string.measure_suggested_confidence,
                    estimate.gender?.let {
                        stringResource(
                            R.string.measure_suggested_gender,
                            stringResource(R.string.measure_suggested_size, estimate.size),
                            it,
                        )
                    } ?: stringResource(R.string.measure_suggested_size, estimate.size),
                    estimate.confidencePercent,
                ),
                style = MaterialTheme.typography.bodyMedium,
            )
            if (estimate.lowConfidence) {
                // The server's own verdict, not a threshold re-derived here —
                // one place decides what "low" means.
                Text(
                    stringResource(R.string.measure_low_confidence),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            estimate.rationale.takeIf { it.isNotBlank() }?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                BrandSecondaryButton(
                    text = stringResource(R.string.measure_use_size, estimate.size),
                    modifier = Modifier.weight(1f),
                ) { onApply(estimate.size) }
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_no_thanks)) }
            }
        }

        errorMessage?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

/**
 * US-2921: one note when the size on the label disagrees with the measurements.
 *
 * ONE for the whole section rather than one per field: a dress can disagree on
 * waist and hip at once, and saying the same thing twice reads as two problems.
 * Publishing is never blocked by it — US-2915 decided this check offers a fix
 * and gets out of the way.
 */
@Composable
fun SizeCheckNote(
    verdict: SizeCheck.Verdict,
    labelledSize: String,
    tier: String,
    brandLabel: String?,
    dismissed: Boolean,
    onChangeSize: (String) -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val implied = verdict.impliedSize
    if (verdict.status != SizeCheck.Status.OFF || implied == null || dismissed) return

    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
        Text(
            stringResource(R.string.size_check_note, implied, labelledSize),
            style = MaterialTheme.typography.bodySmall,
        )
        verdict.expected?.takeIf { it.size == 2 }?.let { band ->
            Text(
                stringResource(
                    R.string.size_check_expected,
                    labelledSize,
                    MeasurementCatalog.editableString(band[0]),
                    MeasurementCatalog.editableString(band[1]),
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        // A generic chart is an estimate and must say so out loud: US-2915
        // accepted that this check catches gross errors and stays quiet on
        // subtle ones, and a note that hides which kind of chart it used cannot
        // be judged by the person reading it.
        if (tier == "generic") {
            Text(
                if (brandLabel.isNullOrBlank()) {
                    stringResource(R.string.size_check_estimate_generic)
                } else {
                    stringResource(R.string.size_check_estimate_brand, brandLabel)
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        // Absent when the measurements land off the end of the chart: "smaller
        // than XS" is not a size the brand makes, so there is nothing to change
        // TO and the seller has to decide.
        val fix = SizeCheck.fixableSize(verdict)
        // Read outside the semantics lambda — stringResource is a Composable and
        // cannot be called from inside one.
        val changeSpoken = fix?.let {
            stringResource(R.string.size_check_change_to_a11y, labelledSize, it)
        }
        val dismissSpoken = stringResource(R.string.size_check_dismiss_a11y)
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            if (fix != null && changeSpoken != null) {
                TextButton(
                    onClick = { onChangeSize(fix) },
                    modifier = Modifier.semantics { contentDescription = changeSpoken },
                ) { Text(stringResource(R.string.size_check_change_to, fix)) }
            }
            TextButton(
                onClick = onDismiss,
                modifier = Modifier.semantics { contentDescription = dismissSpoken },
            ) { Text(stringResource(R.string.common_dismiss)) }
        }
    }
}
