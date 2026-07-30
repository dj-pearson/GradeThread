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
        Text("Analytics", style = MaterialTheme.typography.titleLarge)
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
                        "Nothing to analyse yet",
                        "Add items and record a few sales, and this fills in by itself.",
                    )
                }
            }

            item { PeriodCard(state) }
            item { NarrativeCard(narrative, onGenerate = viewModel::generateNarrative) }

            if (state.gradeDistribution.isNotEmpty()) {
                item {
                    Panel(
                        "Grade distribution",
                        state.averageGrade?.let {
                            "${state.gradedCount} graded · average ${"%.1f".format(it)}"
                        },
                    ) {
                        BarChart(
                            bars = state.gradeDistribution.map {
                                BarDatum(it.tier, it.count.toDouble())
                            },
                            description = "Graded items by tier: " +
                                state.gradeDistribution.joinToString {
                                    "${it.tier} ${it.count}"
                                },
                        )
                    }
                }
            }

            if (state.topBrands.isNotEmpty()) {
                item {
                    Panel("Top brands by profit", "Over ${state.range.label.lowercase()}") {
                        RankedBars(
                            rows = state.topBrands.map {
                                RankedDatum(
                                    it.brand,
                                    it.netProfit,
                                    Money.formatCompact(it.netProfit),
                                )
                            },
                            description = "Top brands by net profit: " +
                                state.topBrands.joinToString {
                                    "${it.brand} ${Money.formatCompact(it.netProfit)}"
                                },
                        )
                    }
                }
            }

            if (state.sellThrough.isNotEmpty()) {
                item {
                    Panel(
                        "Sell-through by brand",
                        // Says what the denominator is. "60%" with no basis is a
                        // number people argue with.
                        "Of the items that reached the market",
                    ) {
                        RankedBars(
                            rows = state.sellThrough.map {
                                RankedDatum(
                                    it.brand,
                                    it.rate,
                                    "${it.sold}/${it.listed}",
                                )
                            },
                            description = "Sell-through by brand: " +
                                state.sellThrough.joinToString {
                                    "${it.brand} ${it.sold} of ${it.listed}"
                                },
                        )
                    }
                }
            }

            if (state.inventoryValue.isNotEmpty()) {
                item {
                    Panel(
                        "Inventory value by status",
                        "${Money.format(state.inventoryTotal)} on hand",
                    ) {
                        RankedBars(
                            rows = state.inventoryValue.map {
                                RankedDatum(
                                    it.status.replaceFirstChar { c -> c.uppercase() },
                                    it.value,
                                    Money.formatCompact(it.value),
                                )
                            },
                            description = "On-hand inventory value by status: " +
                                state.inventoryValue.joinToString {
                                    "${it.status} ${Money.formatCompact(it.value)}"
                                },
                        )
                    }
                }
            }

            if (state.roiBuckets.isNotEmpty()) {
                item { RoiPanel(state.roiBuckets) }
            }

            item {
                BrandSecondaryButton(
                    text = "Listing performance",
                    modifier = Modifier.fillMaxWidth(),
                ) { onOpenListingPerformance() }
            }
        }

        BrandSecondaryButton(text = "Back", modifier = Modifier.fillMaxWidth()) { onClose() }
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
private fun RangePicker(
    selected: AnalyticsRange,
    onPick: (AnalyticsRange) -> Unit,
    onCustom: () -> Unit,
) {
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
            label = { Text(if (selected in AnalyticsRange.presets) "Custom" else selected.label) },
        )
    }
}

@Composable
private fun CustomRangeDialog(onDismiss: () -> Unit, onConfirm: (Int) -> Unit) {
    var text by remember { mutableStateOf("") }
    val days = text.toIntOrNull()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Custom range") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                Text("How many days back?")
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
            ) { Text("Apply") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
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
            "${Money.format(state.pnl.grossProfit)} profit on " +
                "${Money.format(state.pnl.grossRevenue)} revenue",
            style = MaterialTheme.typography.bodyLarge,
        )
        Text(
            "${state.pnl.unitsSold} sold · ${Money.format(state.pnl.fees)} fees · " +
                "${Money.format(state.pnl.cogs)} cost of goods",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        state.overallSellThrough?.let {
            Text(
                "Sell-through ${Money.formatPercent(it)}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun NarrativeCard(
    state: AnalyticsViewModel.NarrativeState,
    onGenerate: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Text("What this means", style = MaterialTheme.typography.titleMedium)
        val narrative = state.narrative
        when {
            narrative != null -> {
                Text(narrative.summary, style = MaterialTheme.typography.bodyMedium)
                narrative.highlights.forEach {
                    Text("• $it", style = MaterialTheme.typography.bodySmall)
                }
                if (narrative.actions.isNotEmpty()) {
                    Text(
                        "Next",
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.Medium,
                    )
                    narrative.actions.forEach {
                        Text("• $it", style = MaterialTheme.typography.bodySmall)
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
                InfoCard("No summary", state.errorMessage, tone = InfoTone.Warning)

            else -> Text(
                // Naming the cost before they tap it. A quota spent by surprise
                // is the kind of thing people remember.
                "Get a plain-language read on these numbers. Uses one AI action.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        BrandPrimaryButton(
            text = when {
                state.generating -> "Writing…"
                state.narrative != null -> "Write it again"
                else -> "Summarise"
            },
            enabled = !state.generating,
            modifier = Modifier.fillMaxWidth(),
        ) { onGenerate() }
    }
}

@Composable
private fun RoiPanel(buckets: List<RoiBucket>) {
    Panel("Does grading pay?", "Graded versus ungraded, by sale price") {
        Column(verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
            buckets.forEach { bucket ->
                Text(bucket.band, style = MaterialTheme.typography.bodyMedium)
                Text(
                    if (!bucket.meaningful) {
                        // Refusing to answer is the honest option. A "+$40 from
                        // grading" built on one sale is how someone talks
                        // themselves into a spending decision on noise.
                        "Not enough sales yet to compare " +
                            "(${bucket.gradedCount} graded, ${bucket.ungradedCount} not)."
                    } else {
                        val lift = bucket.netProfitLift ?: 0.0
                        val verb = if (lift >= 0) "more" else "less"
                        "Graded items netted ${Money.format(kotlin.math.abs(lift))} $verb " +
                            "on average (${bucket.gradedCount} vs ${bucket.ungradedCount})."
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
