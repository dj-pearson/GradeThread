package com.gradethread.app.marketplaces.publish

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import com.gradethread.app.inventory.AspectSpecState
import com.gradethread.app.inventory.AspectSync
import com.gradethread.app.inventory.EbayAspect
import com.gradethread.app.ui.components.LabeledDropdown
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1353: the listing-time item-specifics editor.
 *
 * Renders what the category actually asks for: a closed list becomes a picker
 * (single) or chips (multi), anything else is a text box. Required aspects come
 * first and say so, because they are the ones that block the publish.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SpecificsSection(
    state: PublishViewModel.State,
    onSet: (EbayAspect, List<String>) -> Unit,
) {
    Column(
        Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(stringResource(R.string.specifics_title), style = MaterialTheme.typography.titleMedium)

        when (val spec = state.specState) {
            is AspectSpecState.Loading -> Hint(stringResource(R.string.specifics_loading))

            // Distinct from a failure: the fix is to resolve a category, not to
            // retry. Saying "couldn't load" here would send the seller looking
            // for a network problem that isn't there.
            is AspectSpecState.NoCategory -> Hint(stringResource(R.string.specifics_no_category))

            is AspectSpecState.Failed -> Hint(spec.message)
            is AspectSpecState.Idle -> Unit
            is AspectSpecState.Loaded -> {
                spec.categoryName?.takeIf { it.isNotBlank() }?.let {
                    Hint(stringResource(R.string.specifics_category, it))
                }
                state.specificFields.forEach { field -> SpecificField(field, onSet) }
                if (state.specificFields.isEmpty()) {
                    Hint(stringResource(R.string.specifics_none))
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SpecificField(
    field: ListingSpecifics.Field,
    onSet: (EbayAspect, List<String>) -> Unit,
) {
    val aspect = field.aspect
    val label = if (aspect.required) {
        stringResource(R.string.specifics_required, aspect.name)
    } else {
        aspect.name
    }

    when {
        // A closed list the seller may pick several from.
        aspect.selectionOnly && aspect.multiValued -> {
            Text(label, style = MaterialTheme.typography.bodyMedium)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
                aspect.allowedValues.forEach { option ->
                    val selected = field.values.any { it.equals(option, ignoreCase = true) }
                    FilterChip(
                        selected = selected,
                        onClick = {
                            onSet(
                                aspect,
                                if (selected) {
                                    field.values.filterNot { it.equals(option, true) }
                                } else {
                                    field.values + option
                                },
                            )
                        },
                        label = { Text(option) },
                    )
                }
            }
        }

        // A closed list with one answer.
        aspect.selectionOnly -> LabeledDropdown(
            label = label,
            selected = field.values.firstOrNull(),
            options = aspect.allowedValues,
            optionLabel = { it },
            onSelect = { onSet(aspect, listOf(it)) },
            placeholder = stringResource(R.string.specifics_choose_one),
            modifier = Modifier.fillMaxWidth(),
        )

        else -> OutlinedTextField(
            value = field.values.joinToString(", "),
            onValueChange = { text ->
                // MULTI free-text aspects are comma-separated on eBay's side
                // too, so splitting here matches what gets published.
                onSet(
                    aspect,
                    if (aspect.multiValued) text.split(",") else listOf(text),
                )
            },
            label = { Text(label) },
            singleLine = !aspect.multiValued,
            modifier = Modifier.fillMaxWidth(),
        )
    }

    field.autoFilledFrom?.let {
        // Not a gap. Saying so stops a seller from typing a measurement the
        // publish is about to overwrite with the item's own.
        Hint(stringResource(R.string.specifics_autofilled, it))
    }
    if (field.values.any { AspectSync.willBeTruncated(it) }) {
        Hint(
            stringResource(
                R.string.specifics_truncated,
                AspectSync.EBAY_ASPECT_VALUE_MAX_LEN,
            ),
        )
    }
}

@Composable
private fun Hint(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}
