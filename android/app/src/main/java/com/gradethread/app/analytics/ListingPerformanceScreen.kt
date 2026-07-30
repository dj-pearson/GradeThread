package com.gradethread.app.analytics

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.money.Money
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-1368: how each live listing is actually doing.
 */
@Composable
fun ListingPerformanceScreen(
    onOpenItem: (String) -> Unit = {},
    onClose: () -> Unit = {},
    viewModel: ListingPerformanceViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    LaunchedEffect(Unit) { viewModel.load() }

    Column(
        Modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text("Listing performance", style = MaterialTheme.typography.titleLarge)
        Text(
            state.summary,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        when (state.analyticsDenied) {
            true -> InfoCard(
                "eBay isn't sharing traffic data",
                "Reconnect your eBay account and approve the analytics permission to see " +
                    "views and impressions.",
                tone = InfoTone.Warning,
            )
            null -> if (state.loaded) {
                InfoCard(
                    "No eBay account connected",
                    "Connect eBay from Marketplaces to see how your listings are doing.",
                )
            }
            false -> Unit
        }
        state.errorMessage?.let { InfoCard("That didn't work", it, tone = InfoTone.Error) }

        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(Spacing.xxs),
        ) {
            ListingPerformanceSort.entries.forEach { option ->
                FilterChip(
                    selected = option == state.sort,
                    onClick = { viewModel.setSort(option) },
                    label = {
                        Text(
                            if (option == state.sort) {
                                "${option.label} ${if (state.ascending) "↑" else "↓"}"
                            } else {
                                option.label
                            },
                        )
                    },
                )
            }
        }

        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(Spacing.xxs),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "No views in",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            ListingPerformance.noViewWindows.forEach { days ->
                FilterChip(
                    selected = state.noViewDays == days,
                    onClick = { viewModel.toggleNoViewFilter(days) },
                    label = { Text("${days}d") },
                )
            }
        }

        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            items(state.visible, key = { it.id }) { row ->
                PerformanceCard(row, state.nowMs, onOpenItem)
            }
            if (state.visible.isEmpty() && state.loaded) {
                item {
                    Text(
                        if (state.noViewDays == null) {
                            "Nothing to show."
                        } else {
                            // The filter is why the list is empty, and that is
                            // good news worth saying out loud.
                            "No listings have gone ${state.noViewDays} days without a view."
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        BrandSecondaryButton(
            text = if (state.loading) "Refreshing…" else "Refresh",
            enabled = !state.loading,
            modifier = Modifier.fillMaxWidth(),
        ) { viewModel.load() }
        BrandSecondaryButton(text = "Back", modifier = Modifier.fillMaxWidth()) { onClose() }
    }
}

@Composable
private fun PerformanceCard(
    row: ListingPerformanceRow,
    nowMs: Long,
    onOpenItem: (String) -> Unit,
) {
    val stale = ListingPerformance.isStale(row, nowMs)
    Column(
        Modifier
            .fillMaxWidth()
            .clickable { onOpenItem(row.inventoryItemId) }
            .cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Text(
            row.displayTitle,
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = FontWeight.Medium,
            maxLines = 2,
        )
        Text(
            "${Money.format(row.listingPrice)} · " +
                "${ListingPerformance.daysListed(row.listedAtMs, nowMs)} days live",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            buildString {
                append("${row.viewsTotal} views")
                ListingPerformance.viewsPerDay(row, nowMs)?.let {
                    append(" (${"%.1f".format(it)}/day)")
                }
                append(" · ${row.watchersCount} watchers")
                append(" · ${row.impressions7d} impressions")
            },
            style = MaterialTheme.typography.bodySmall,
            color = if (stale) {
                MaterialTheme.colorScheme.error
            } else {
                MaterialTheme.colorScheme.onSurface
            },
        )
        row.clickThroughRate?.let {
            Text(
                "Click-through ${Money.formatPercent(it)}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (stale) {
            Text(
                "Two weeks live with no views. Try new photos, a new title, or a lower price.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}
