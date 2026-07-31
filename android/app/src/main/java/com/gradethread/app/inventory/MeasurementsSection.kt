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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import com.gradethread.app.R
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
                        label = { Text("+ ${MeasurementCatalog.label(key)}") },
                    )
                }
            }
        }
    }
}

@Composable
private fun MeasurementField(
    key: String,
    value: Double?,
    onSet: (Double?) -> Unit,
    onRemove: () -> Unit,
) {
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
            label = { Text("${MeasurementCatalog.label(key)} (${spec.unit})") },
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
