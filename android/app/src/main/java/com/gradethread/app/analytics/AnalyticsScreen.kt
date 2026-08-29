package com.gradethread.app.analytics

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.money.Money
import com.gradethread.app.ui.components.BarChart
import com.gradethread.app.ui.components.BarDatum
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.components.RankedBars
import com.gradethread.app.ui.components.RankedDatum
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-1368: the analytics tab.
 *
 * Charts are Compose `Canvas`, not a charting library — the same call US-1363
 * made and for the same reason: the app already has an APK-size problem from ML
 * Kit's native libraries across four ABIs, and a chart engine for five static
 * shapes would add weight to precisely the thing that needs trimming. The
 * substance of the AC is the charts, and they are here.
 */
@Composable
fun AnalyticsScreen(
    onOpenListingPerformance: () -> Unit = {},
    onOpenCommunity: () -> Unit = {},
    onClose: () -> Unit = {},
    viewModel: AnalyticsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val narrative by viewModel.narrative.collectAsState()
    var customOpen by remember { mutableStateOf(false) }

    Column(
        Modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(stringResource(R.string.analytics_analytics), style = MaterialTheme.typography.titleLarge)
        RangePicker(
            selected = state.range,
            onPick = viewModel::setRange,
            onCustom = { customOpen = true },
        )

        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            if (!state.hasAnything) {
                item {
                    InfoCard(
                        stringResource(R.string.analytics_empty_title),
                        stringResource(R.string.analytics_empty_body),
                    )
                }
            }

            item { PeriodCard(state) }
            item { NarrativeCard(narrative, onGenerate = viewModel::generateNarrative) }

            if (state.gradeDistribution.isNotEmpty()) {
                item {
                    val tierItem = stringResource(R.string.analytics_pair_spoken_item)
                    Panel(
                        stringResource(R.string.analytics_grade_distribution),
                        state.averageGrade?.let {
                            pluralStringResource(
                                R.plurals.analytics_graded_average,
                                state.gradedCount,
                                state.gradedCount,
                                "%.1f".format(it),
                            )
                        },
                    ) {
                        BarChart(
                            bars = state.gradeDistribution.map {
                                BarDatum(it.tier, it.count.toDouble())
                            },
                            description = stringResource(
                                R.string.analytics_grade_distribution_spoken,
                                state.gradeDistribution.joinToString {
                                    tierItem.format(it.tier, it.count)
                                },
                            ),
                        )
                    }
                }
            }

            if (state.topBrands.isNotEmpty()) {
                item {
                    val brandItem = stringResource(R.string.analytics_pair_spoken_item)
                    Panel(
                        stringResource(R.string.analytics_top_brands),
                        stringResource(
                            R.string.analytics_over_range,
                            state.range.label.lowercase(),
                        ),
                    ) {
                        RankedBars(
                            rows = state.topBrands.map {
                                RankedDatum(
                                    it.brand,
                                    it.netProfit,
                                    Money.formatCompact(it.netProfit),
                                )
                            },
                            description = stringResource(
                                R.string.analytics_top_brands_spoken,
                                state.topBrands.joinToString {
                                    brandItem.format(
                                        it.brand,
                                        Money.formatCompact(it.netProfit),
                                    )
                                },
                            ),
                        )
                    }
                }
            }

            if (state.sellThrough.isNotEmpty()) {
                item {
                    val sellItem = stringResource(R.string.analytics_sell_through_spoken_item)
                    val ratio = stringResource(R.string.analytics_ratio)
                    Panel(
                        stringResource(R.string.analytics_sell_through_title),
                        // Says what the denominator is. "60%" with no basis is a
                        // number people argue with.
                        stringResource(R.string.analytics_sell_through_basis),
                    ) {
                        RankedBars(
                            rows = state.sellThrough.map {
                                RankedDatum(
                                    it.brand,
                                    it.rate,
                                    ratio.format(it.sold, it.listed),
                                )
                            },
                            description = stringResource(
                                R.string.analytics_sell_through_spoken,
                                state.sellThrough.joinToString {
                                    sellItem.format(it.brand, it.sold, it.listed)
                                },
                            ),
                        )
                    }
                }
            }

            if (state.inventoryValue.isNotEmpty()) {
                item {
                    val statusItem = stringResource(R.string.analytics_pair_spoken_item)
                    Panel(
                        stringResource(R.string.analytics_inventory_value),
                        stringResource(
                            R.string.analytics_on_hand_total,
                            Money.format(state.inventoryTotal),
                        ),
                    ) {
                        RankedBars(
                            rows = state.inventoryValue.map {
                                RankedDatum(
                                    it.status.replaceFirstChar { c -> c.uppercase() },
                                    it.value,
                                    Money.formatCompact(it.value),
                                )
                            },
                            description = stringResource(
                                R.string.analytics_inventory_value_spoken,
                                state.inventoryValue.joinToString {
                                    statusItem.format(
                                        it.status,
                                        Money.formatCompact(it.value),
                                    )
                                },
                            ),
                        )
                    }
                }
            }

            if (state.roiBuckets.isNotEmpty()) {
                item { RoiPanel(state.roiBuckets) }
            }

            item {
                BrandSecondaryButton(
                    text = stringResource(R.string.analytics_listing_performance),
                    modifier = Modifier.fillMaxWidth(),
                ) { onOpenListingPerformance() }
            }
            item {
                BrandSecondaryButton(
                    text = stringResource(R.string.analytics_community_benchmarks),
                    modifier = Modifier.fillMaxWidth(),
                ) { onOpenCommunity() }
            }
        }

        BrandSecondaryButton(text = stringResource(R.string.analytics_back), modifier = Modifier.fillMaxWidth()) {
            onClose()
        }
    }

    if (customOpen) {
        CustomRangeDialog(
            onDismiss = { customOpen = false },
            onConfirm = { days ->
                customOpen = false
                viewModel.setCustomRange(days)
            },
        )
    }
}

@Composable
private fun RangePicker(selected: AnalyticsRange, onPick: (AnalyticsRange) -> Unit, onCustom: () -> Unit) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(Spacing.xxs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AnalyticsRange.presets.forEach { option ->
            FilterChip(
                selected = option == selected,
                onClick = { onPick(option) },
                label = { Text(option.label) },
            )
        }
        FilterChip(
            // Selected when the current range is a window the presets don't
            // offer, so a custom choice doesn't look unselected.
            selected = selected !in AnalyticsRange.presets,
            onClick = onCustom,
            label = {
                Text(
                    if (selected in AnalyticsRange.presets) {
                        stringResource(R.string.analytics_custom)
                    } else {
                        selected.label
                    },
                )
            },
        )
    }
}

@Composable
private fun CustomRangeDialog(onDismiss: () -> Unit, onConfirm: (Int) -> Unit) {
    var text by remember { mutableStateOf("") }
    val days = text.toIntOrNull()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.analytics_custom_range)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                Text(stringResource(R.string.analytics_how_many_days_back))
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it.filter { c -> c.isDigit() }.take(4) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { days?.let(onConfirm) },
                enabled = days != null && days > 0,
            ) { Text(stringResource(R.string.analytics_apply)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.analytics_cancel)) } },
    )
}

@Composable
private fun PeriodCard(state: AnalyticsViewModel.State) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Text(state.range.label, style = MaterialTheme.typography.titleMedium)
        Text(
            stringResource(
                R.string.analytics_profit_on_revenue,
                Money.format(state.pnl.grossProfit),
                Money.format(state.pnl.grossRevenue),
            ),
            style = MaterialTheme.typography.bodyLarge,
        )
        Text(
            pluralStringResource(
                R.plurals.analytics_units_fees_cogs,
                state.pnl.unitsSold,
                state.pnl.unitsSold,
                Money.format(state.pnl.fees),
                Money.format(state.pnl.cogs),
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        state.overallSellThrough?.let {
            Text(
                stringResource(R.string.analytics_sell_through, Money.formatPercent(it)),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun NarrativeCard(state: AnalyticsViewModel.NarrativeState, onGenerate: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Text(stringResource(R.string.analytics_what_this_means), style = MaterialTheme.typography.titleMedium)
        val narrative = state.narrative
        when {
            narrative != null -> {
                Text(narrative.summary, style = MaterialTheme.typography.bodyMedium)
                narrative.highlights.forEach {
                    Text(
                        stringResource(R.string.analytics_bullet, it),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                if (narrative.actions.isNotEmpty()) {
                    Text(
                        stringResource(R.string.analytics_next),
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.Medium,
                    )
                    narrative.actions.forEach {
                        Text(
                            stringResource(R.string.analytics_bullet, it),
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
                narrative.remainingLabel?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            state.errorMessage != null ->
                InfoCard(
                    stringResource(R.string.analytics_no_summary),
                    state.errorMessage,
                    tone = InfoTone.Warning,
                )

            else -> Text(
                // Naming the cost before they tap it. A quota spent by surprise
                // is the kind of thing people remember.
                stringResource(R.string.analytics_summary_cost),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        BrandPrimaryButton(
            text = stringResource(
                when {
                    state.generating -> R.string.analytics_writing
                    state.narrative != null -> R.string.analytics_write_again
                    else -> R.string.analytics_summarise
                },
            ),
            enabled = !state.generating,
            modifier = Modifier.fillMaxWidth(),
        ) { onGenerate() }
    }
}

@Composable
private fun RoiPanel(buckets: List<RoiBucket>) {
    Panel(
        stringResource(R.string.analytics_roi_title),
        stringResource(R.string.analytics_roi_subtitle),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
            buckets.forEach { bucket ->
                Text(bucket.band, style = MaterialTheme.typography.bodyMedium)
                Text(
                    if (!bucket.meaningful) {
                        // Refusing to answer is the honest option. A "+$40 from
                        // grading" built on one sale is how someone talks
                        // themselves into a spending decision on noise.
                        stringResource(
                            R.string.analytics_roi_not_enough,
                            bucket.gradedCount,
                            bucket.ungradedCount,
                        )
                    } else {
                        val lift = bucket.netProfitLift ?: 0.0
                        // Two whole sentences rather than a swapped word: "more"
                        // and "less" do not sit in the same place in every
                        // language, and a spliced verb cannot be translated.
                        stringResource(
                            if (lift >= 0) {
                                R.string.analytics_roi_more
                            } else {
                                R.string.analytics_roi_less
                            },
                            Money.format(kotlin.math.abs(lift)),
                            bucket.gradedCount,
                            bucket.ungradedCount,
                        )
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun Panel(title: String, subtitle: String?, content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Column {
            Text(title, style = MaterialTheme.typography.titleMedium)
            subtitle?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        content()
    }
}
