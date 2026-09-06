package com.gradethread.app.inventory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Button
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import com.gradethread.app.R
import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1342: the multi-facet filter sheet.
 *
 * Edits a DRAFT copy of the criteria and only commits on Apply, so a
 * half-built filter never churns the list underneath the sheet. The live
 * "Show N items" count is computed against the draft, which is why it
 * deliberately bypasses the memo — the draft isn't the committed criteria,
 * so caching it would poison the slot the real list depends on.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun InventoryFilterSheet(
    facets: InventoryFacets,
    committed: InventoryFilterCriteria,
    allItems: List<InventoryItemEntity>,
    stage: InventoryStage,
    photoItemIds: Set<String>,
    onApply: (InventoryFilterCriteria) -> Unit,
    onClear: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var draft by remember(committed) { mutableStateOf(committed) }

    val matchCount = remember(draft, allItems, stage) {
        allItems.count { item ->
            stage.matches(item.status) &&
                InventoryFilter.matches(item, draft, photoItemIds, System.currentTimeMillis())
        }
    }

    Column(modifier.fillMaxWidth().padding(Spacing.md)) {
        Text(stringResource(R.string.filters_title), style = MaterialTheme.typography.titleLarge)

        LazyColumn(Modifier.weight(1f, fill = false)) {
            facetSection("Brand", facets.brands, draft.brands) { selected ->
                draft = draft.copy(brands = selected)
            }
            facetSection("Size", facets.sizes, draft.sizes) { selected ->
                draft = draft.copy(sizes = selected)
            }
            facetSection("Color", facets.colors, draft.colors) { selected ->
                draft = draft.copy(colors = selected)
            }
            facetSection("Category", facets.categories, draft.categories) { selected ->
                draft = draft.copy(categories = selected)
            }
            facetSection("Bin", facets.locationBins, draft.locationBins) { selected ->
                draft = draft.copy(locationBins = selected)
            }
            facetSection("Source", facets.sources, draft.sources) { selected ->
                draft = draft.copy(sources = selected)
            }
            // US-3124. Directly under Source, because one is where the item
            // came from and the other is who bought it.
            facetSection("Sourced by", facets.sourcers, draft.sourcers) { selected ->
                draft = draft.copy(sourcers = selected)
            }

            item {
                SectionLabel(stringResource(R.string.filters_section_grade))
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                    FilterChip(
                        selected = draft.gradedOnly,
                        onClick = { draft = draft.copy(gradedOnly = !draft.gradedOnly) },
                        label = { Text(stringResource(R.string.filters_graded_only)) },
                    )
                    listOf(7.0, 8.0, 9.0).forEach { min ->
                        FilterChip(
                            selected = draft.minGrade == min,
                            onClick = {
                                draft = draft.copy(
                                    minGrade = if (draft.minGrade == min) null else min,
                                )
                            },
                            label = {
                                Text(stringResource(R.string.filters_min_price, min.toInt()))
                            },
                        )
                    }
                }
            }

            item {
                SectionLabel(stringResource(R.string.filters_section_price))
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                    PriceField(stringResource(R.string.filters_price_min), draft.minPrice) {
                        draft = draft.copy(minPrice = it)
                    }
                    PriceField(stringResource(R.string.filters_price_max), draft.maxPrice) {
                        draft = draft.copy(maxPrice = it)
                    }
                }
                // The asymmetry is surprising enough to state outright.
                if (draft.minPrice != null) {
                    Text(
                        stringResource(R.string.filters_no_price_hidden),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            item {
                SectionLabel(stringResource(R.string.filters_section_photos))
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                    PhotoState.entries.forEach { state ->
                        FilterChip(
                            selected = draft.photoState == state,
                            onClick = { draft = draft.copy(photoState = state) },
                            label = {
                                Text(
                                    when (state) {
                                        PhotoState.ANY ->
                                            stringResource(R.string.filters_photos_any)
                                        PhotoState.WITH_PHOTO ->
                                            stringResource(R.string.filters_photos_with)
                                        PhotoState.MISSING_PHOTO ->
                                            stringResource(R.string.filters_photos_missing)
                                    },
                                )
                            },
                        )
                    }
                }
            }

            item {
                SectionLabel(stringResource(R.string.filters_section_added))
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                    DateAddedBand.entries.forEach { band ->
                        FilterChip(
                            selected = draft.dateAdded == band,
                            onClick = { draft = draft.copy(dateAdded = band) },
                            label = {
                                Text(
                                    band.days?.let {
                                        pluralStringResource(
                                            R.plurals.filters_added_last_days,
                                            it,
                                            it,
                                        )
                                    } ?: stringResource(R.string.filters_added_any),
                                )
                            },
                        )
                    }
                }
            }
        }

        Button(
            onClick = { onApply(draft) },
            modifier = Modifier.fillMaxWidth().padding(top = Spacing.md),
        ) {
            Text(pluralStringResource(R.plurals.filters_show_items, matchCount, matchCount))
        }

        TextButton(
            onClick = onClear,
            modifier = Modifier.fillMaxWidth(),
            enabled = !draft.isEmpty,
        ) { Text(stringResource(R.string.common_clear_all)) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
private fun androidx.compose.foundation.lazy.LazyListScope.facetSection(
    title: String,
    values: List<FacetValue>,
    selected: Set<String>,
    onChange: (Set<String>) -> Unit,
) {
    // A facet with no values in the current set is noise, not an empty state.
    if (values.isEmpty()) return
    item {
        SectionLabel(title)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            values.forEach { facet ->
                FilterChip(
                    selected = facet.value in selected,
                    onClick = {
                        onChange(
                            if (facet.value in selected) {
                                selected - facet.value
                            } else {
                                selected + facet.value
                            },
                        )
                    },
                    label = {
                        Text(stringResource(R.string.filters_facet, facet.label, facet.count))
                    },
                )
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelLarge,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(top = Spacing.sm, bottom = Spacing.xxs),
    )
}

@Composable
private fun PriceField(label: String, value: Double?, onChange: (Double?) -> Unit) {
    OutlinedTextField(
        value = value?.let { "%.0f".format(it) } ?: "",
        // A partially-typed number parses to null, which clears the bound
        // rather than snapping to a stale value mid-edit.
        onValueChange = { text -> onChange(text.takeIf { it.isNotBlank() }?.toDoubleOrNull()) },
        label = { Text(label) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
    )
}
