package com.gradethread.app.inventory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.FilterChip
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
import com.gradethread.app.R
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1347: the eBay item-specifics editor.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AspectsSection(
    spec: AspectSpecState,
    values: Map<String, List<String>>,
    sources: Map<String, AspectSync.Provenance>,
    missingRequired: List<String>,
    onLoad: () -> Unit,
    onSet: (String, List<String>) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
        Text(
            stringResource(R.string.aspects_title),
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
        )

        if (missingRequired.isNotEmpty()) {
            // The publish blocker, stated here rather than discovered at
            // publish time — and NAMED, so the seller knows what to fill.
            Text(
                stringResource(
                    R.string.aspects_required_missing,
                    missingRequired.joinToString(),
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }

        when (spec) {
            AspectSpecState.Idle -> BrandSecondaryButton(
                text = stringResource(R.string.aspects_load),
                modifier = Modifier.fillMaxWidth(),
            ) { onLoad() }

            AspectSpecState.Loading -> Text(
                stringResource(R.string.aspects_loading),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            AspectSpecState.NoCategory -> Text(
                stringResource(R.string.aspects_no_category),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            is AspectSpecState.Failed -> Column {
                Text(
                    spec.message,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
                TextButton(onClick = onLoad) { Text(stringResource(R.string.common_try_again)) }
            }

            is AspectSpecState.Loaded -> {
                spec.categoryName?.takeIf { it.isNotBlank() }?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                AspectSpecs.ordered(spec.aspects).forEach { aspect ->
                    AspectRow(
                        aspect = aspect,
                        values = values[aspect.name].orEmpty(),
                        source = sources[aspect.name],
                        onSet = { onSet(aspect.name, it) },
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AspectRow(
    aspect: EbayAspect,
    values: List<String>,
    source: AspectSync.Provenance?,
    onSet: (List<String>) -> Unit,
) {
    val syncedField = remember(aspect.name) { AspectRegistry.syncedFieldFor(aspect.name) }

    Column(Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                aspect.name + if (aspect.required) " *" else "",
                style = MaterialTheme.typography.labelMedium,
            )
            source?.let {
                Text(
                    "  ${it.badge}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        syncedField?.let {
            // Says WHY editing this may move something else — one entry feeds
            // both the item field and the listing specific.
            Text(
                stringResource(R.string.aspects_synced_with, it),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        if (aspect.selectionOnly && aspect.allowedValues.isNotEmpty()) {
            // A closed list: chips only. Free typing here would produce a value
            // eBay rejects at publish, taking the whole listing with it.
            FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
                aspect.allowedValues.forEach { option ->
                    val selected = option in values
                    FilterChip(
                        selected = selected,
                        onClick = {
                            onSet(
                                when {
                                    selected -> values - option
                                    aspect.multiValued -> values + option
                                    else -> listOf(option)
                                },
                            )
                        },
                        label = { Text(option) },
                    )
                }
            }
        } else {
            FreeTextAspect(aspect, values, onSet)
        }
    }
}

@Composable
private fun FreeTextAspect(
    aspect: EbayAspect,
    values: List<String>,
    onSet: (List<String>) -> Unit,
) {
    var text by remember(aspect.name, values) { mutableStateOf(values.joinToString(", ")) }
    val tooLong = AspectSync.willBeTruncated(text)

    Column {
        OutlinedTextField(
            value = text,
            onValueChange = { entered ->
                text = entered
                onSet(
                    if (aspect.multiValued) {
                        entered.split(",").map { it.trim() }.filter { it.isNotEmpty() }
                    } else {
                        listOfNotNull(entered.trim().takeIf { it.isNotEmpty() })
                    },
                )
            },
            label = {
                Text(
                    if (aspect.multiValued) {
                        stringResource(R.string.aspects_comma_separated)
                    } else {
                        stringResource(R.string.common_value)
                    },
                )
            },
            singleLine = !aspect.multiValued,
            isError = tooLong,
            modifier = Modifier.fillMaxWidth(),
        )
        if (tooLong) {
            // Warned here rather than discovered as a stuck offer: eBay caps
            // an item specific at 65 characters and the edge truncates at its
            // own chokepoint, so silence would just lose the tail.
            Text(
                stringResource(
                    R.string.aspects_truncated,
                    AspectSync.EBAY_ASPECT_VALUE_MAX_LEN,
                ),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}
