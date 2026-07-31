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
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.R
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
        Text(
            stringResource(R.string.perf_title),
            style = MaterialTheme.typography.titleLarge,
        )
        Text(
            state.summary,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        when (state.analyticsDenied) {
            true -> InfoCard(
                stringResource(R.string.perf_no_traffic_title),
                stringResource(R.string.perf_no_traffic_body),
                tone = InfoTone.Warning,
            )
            null -> if (state.loaded) {
                InfoCard(
                    stringResource(R.string.perf_no_account_title),
                    stringResource(R.string.perf_no_account_body),
                )
            }
            false -> Unit
        }
        state.errorMessage?.let {
            InfoCard(stringResource(R.string.common_that_didnt_work), it, tone = InfoTone.Error)
        }

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
                                if (state.ascending) {
                                    stringResource(R.string.perf_sort_ascending, option.label)
                                } else {
                                    stringResource(R.string.perf_sort_descending, option.label)
                                }
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
                stringResource(R.string.perf_no_views_in),
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
                    // Bound to a local so the plural gets a non-null Int: a
                    // property read does not smart-cast across the branch.
                    val noViewDays = state.noViewDays
                    Text(
                        if (noViewDays == null) {
                            stringResource(R.string.perf_nothing_to_show)
                        } else {
                            // The filter is why the list is empty, and that is
                            // good news worth saying out loud.
                            pluralStringResource(
                                R.plurals.perf_no_view_days,
                                noViewDays,
                                noViewDays,
                            )
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        BrandSecondaryButton(
            text = if (state.loading) {
                stringResource(R.string.common_refreshing)
            } else {
                stringResource(R.string.common_refresh)
            },
            enabled = !state.loading,
            modifier = Modifier.fillMaxWidth(),
        ) { viewModel.load() }
        BrandSecondaryButton(
            text = stringResource(R.string.common_back),
            modifier = Modifier.fillMaxWidth(),
        ) { onClose() }
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
            stringResource(
                R.string.perf_price_and_age,
                Money.format(row.listingPrice),
                pluralStringResource(
                    R.plurals.perf_days_live,
                    ListingPerformance.daysListed(row.listedAtMs, nowMs),
                    ListingPerformance.daysListed(row.listedAtMs, nowMs),
                ),
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            // Every fragment resolved BEFORE buildString: the builder lambda is
            // where a composable call would be easy to write and wrong to rely
            // on, and each piece needs its own plural anyway.
            viewsLine(row, nowMs),
            style = MaterialTheme.typography.bodySmall,
            color = if (stale) {
                MaterialTheme.colorScheme.error
            } else {
                MaterialTheme.colorScheme.onSurface
            },
        )
        row.clickThroughRate?.let {
            Text(
                stringResource(R.string.perf_click_through, Money.formatPercent(it)),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (stale) {
            Text(
                stringResource(R.string.perf_stale_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

/**
 * The views / watchers / impressions line, assembled from three plurals.
 *
 * Each count agrees on its own, so this cannot be one format string; and the
 * separators sit inside the plural items rather than between them, so a
 * language that punctuates a list differently can move them.
 */
@Composable
private fun viewsLine(row: ListingPerformanceRow, nowMs: Long): String {
    val views = pluralStringResource(R.plurals.perf_views, row.viewsTotal, row.viewsTotal)
    val perDay = ListingPerformance.viewsPerDay(row, nowMs)
        ?.let { stringResource(R.string.perf_views_per_day, "%.1f".format(it)) }
        .orEmpty()
    val watchers =
        pluralStringResource(R.plurals.perf_watchers, row.watchersCount, row.watchersCount)
    val impressions =
        pluralStringResource(R.plurals.perf_impressions, row.impressions7d, row.impressions7d)
    return views + perDay + watchers + impressions
}
