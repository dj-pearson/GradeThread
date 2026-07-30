package com.gradethread.app.analytics

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AssistChip
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
import com.gradethread.app.ui.components.RankedBars
import com.gradethread.app.ui.components.RankedDatum
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-1369: how your numbers sit against everyone else's.
 */
@Composable
fun CommunityInsightsScreen(
    onOpenInventory: () -> Unit = {},
    onClose: () -> Unit = {},
    viewModel: CommunityInsightsViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    LaunchedEffect(Unit) { viewModel.refresh() }

    Column(
        Modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text("Community insights", style = MaterialTheme.typography.titleLarge)
        Text(
            // The privacy promise, said plainly and up front. People are being
            // asked to look at other sellers' numbers; they deserve to know
            // theirs work the same way.
            "Every figure is pooled across at least " +
                "${CommunityRecommendations.MIN_SELLERS} sellers. No individual " +
                "seller's numbers are shown, including yours.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        when (val phase = state.phase) {
            is CommunityInsightsViewModel.Phase.Loading ->
                Text("Loading…", style = MaterialTheme.typography.bodyMedium)

            is CommunityInsightsViewModel.Phase.Locked ->
                InfoCard("Not available", phase.message, tone = InfoTone.Warning)

            is CommunityInsightsViewModel.Phase.Failed ->
                InfoCard("That didn't work", phase.message, tone = InfoTone.Error)

            is CommunityInsightsViewModel.Phase.Ready -> Ready(
                state = state,
                data = phase.data,
                onOpenBrand = { brand -> viewModel.openBrand(brand, onOpenInventory) },
            )
        }

        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
        ) {
            BrandSecondaryButton(text = "Refresh", modifier = Modifier.weight(1f)) {
                viewModel.refresh()
            }
            BrandSecondaryButton(text = "Back", modifier = Modifier.weight(1f)) { onClose() }
        }
    }
}

@Composable
private fun ColumnScope.Ready(
    state: CommunityInsightsViewModel.State,
    data: CommunityBenchmarks,
    onOpenBrand: (String) -> Unit,
) {
    LazyColumn(
        Modifier.fillMaxWidth().weight(1f),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        item { YouCard(state, data) }

        if (!state.hasBenchmarkData) {
            item {
                InfoCard(
                    "Not enough community data yet",
                    "We need more sellers working the same brands and categories before " +
                        "these numbers mean anything. Check back soon.",
                )
            }
        } else if (state.hasDataButNothingActionable) {
            item {
                InfoCard(
                    "Nothing to act on right now",
                    // Distinct from the message above on purpose: there IS
                    // community data, it just isn't telling you to do anything.
                    "We have data for your brands and categories, but nothing in it is " +
                        "strong enough to act on today.",
                )
            }
        }

        if (state.recommendations.isNotEmpty()) {
            item { SectionHeader("What the numbers suggest") }
            items(state.recommendations, key = { it.id }) { rec ->
                RecommendationCard(rec, onOpenBrand)
            }
        }

        if (data.topBrands.isNotEmpty()) {
            item { SectionHeader("Sell-through by brand") }
            item {
                Column(Modifier.fillMaxWidth().cardStyle()) {
                    RankedBars(
                        rows = data.topBrands.take(8).map {
                            RankedDatum(
                                it.brand,
                                it.sellThrough ?: 0.0,
                                Money.formatPercent(it.sellThrough),
                            )
                        },
                        description = "Community sell-through by brand: " +
                            data.topBrands.take(8).joinToString {
                                "${it.brand} ${Money.formatPercent(it.sellThrough)}"
                            },
                    )
                }
            }
            item { SectionHeader("Average sale price") }
            items(data.topBrands.take(8), key = { "price-${it.brand}" }) { brand ->
                BrandPriceRow(brand, onOpenBrand)
            }
        }

        if (data.trendingCategories.isNotEmpty()) {
            item { SectionHeader("Categories on the move") }
            items(data.trendingCategories.take(8), key = { it.category }) { trend ->
                CategoryRow(trend)
            }
        }
    }
}

@Composable
private fun YouCard(state: CommunityInsightsViewModel.State, data: CommunityBenchmarks) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Text("You", style = MaterialTheme.typography.titleMedium)
        Text(
            "${data.you.listed} listed · ${data.you.sold} sold",
            style = MaterialTheme.typography.bodyLarge,
        )
        val standing = state.peerStanding
        Text(
            standing ?: state.peerBlocker.orEmpty(),
            style = MaterialTheme.typography.bodySmall,
            color = if (standing != null) {
                MaterialTheme.colorScheme.onSurface
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
        )
    }
}

@Composable
private fun RecommendationCard(
    rec: CommunityRecommendation,
    onOpenBrand: (String) -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            // Only brand recommendations lead anywhere: the local item mirror
            // has no category column, so a category filter would match nothing
            // and the tap would look broken.
            .then(
                if (rec.brandFilter != null) {
                    Modifier.clickable { onOpenBrand(rec.brandFilter) }
                } else {
                    Modifier
                },
            )
            .cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                rec.title,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f),
            )
            AssistChip(onClick = {}, label = { Text(rec.confidenceLevel.label) })
        }
        Text(
            rec.detail,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (rec.brandFilter != null) {
            Text(
                "Tap to see your ${rec.subject} items",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.primary,
            )
        }
    }
}

@Composable
private fun BrandPriceRow(brand: BrandBenchmark, onOpenBrand: (String) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable { onOpenBrand(brand.brand) }
            .cardStyle(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(brand.brand, style = MaterialTheme.typography.bodyLarge)
            Text(
                "${brand.sellers} sellers · ${brand.sold} of ${brand.listed} sold",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(
            brand.avgSalePrice?.let { Money.format(it) } ?: "—",
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = FontWeight.Medium,
        )
    }
}

@Composable
private fun CategoryRow(trend: CategoryTrend) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Text(trend.category, style = MaterialTheme.typography.bodyLarge)
        Text(
            trend.growth?.let {
                val direction = if (it >= 0) "up" else "down"
                "Sales $direction ${Money.formatPercent(kotlin.math.abs(it))} " +
                    "over 30 days · ${trend.sellers} sellers"
            }
                // No prior-period sales means there is no growth figure. Showing
                // "up 0%" would state a fact nobody measured.
                ?: "${trend.soldRecent} sold in 30 days · ${trend.sellers} sellers",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun SectionHeader(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleMedium,
        modifier = Modifier.padding(top = Spacing.xs),
    )
}
