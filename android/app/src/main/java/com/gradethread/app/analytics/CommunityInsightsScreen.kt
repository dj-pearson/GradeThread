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
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.money.Money
import com.gradethread.app.ui.text
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

    CommunityInsightsContent(
        state,
        CommunityInsightsActions(
            refresh = viewModel::refresh,
            // openBrand needs the navigation callback the wrapper was given, so
            // the binding stays here rather than in the body.
            openBrand = { brand -> viewModel.openBrand(brand, onOpenInventory) },
            close = onClose,
        ),
    )
}

/** Everything this screen can be asked to do (US-2902 AC3). */
@Immutable
data class CommunityInsightsActions(
    val refresh: () -> Unit = {},
    val openBrand: (String) -> Unit = {},
    val close: () -> Unit = {},
)

/**
 * Community benchmarks with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ "NOTHING WORTH ACTING ON" AND "NOT ENOUGH DATA" ARE DIFFERENT SENTENCES,
 * and the ViewModel says so in as many words. Rows exist but none clear the
 * action thresholds is a finished answer; not enough community data is a reason
 * to come back later. Showing the second when the first is true tells a seller
 * to wait for something that has already arrived.
 *
 * ⚠ AND A LOCKED SCREEN IS NOT A FAILED ONE. Locked is a plan boundary carrying
 * the server own sentence; Failed is a fault with a retry. Both render a card.
 */
@Composable
fun CommunityInsightsContent(
    state: CommunityInsightsViewModel.State,
    actions: CommunityInsightsActions,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(stringResource(R.string.community_community_insights), style = MaterialTheme.typography.titleLarge)
        Text(
            // The privacy promise, said plainly and up front. People are being
            // asked to look at other sellers' numbers; they deserve to know
            // theirs work the same way.
            stringResource(
                R.string.community_privacy_note,
                CommunityRecommendations.MIN_SELLERS,
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        when (val phase = state.phase) {
            is CommunityInsightsViewModel.Phase.Loading ->
                Text(stringResource(R.string.community_loading), style = MaterialTheme.typography.bodyMedium)

            is CommunityInsightsViewModel.Phase.Locked ->
                InfoCard(stringResource(R.string.community_not_available), phase.message, tone = InfoTone.Warning)

            is CommunityInsightsViewModel.Phase.Failed ->
                InfoCard(stringResource(R.string.community_that_didn_t_work), phase.message, tone = InfoTone.Error)

            is CommunityInsightsViewModel.Phase.Ready -> Ready(
                state = state,
                data = phase.data,
                onOpenBrand = actions.openBrand,
            )
        }

        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
        ) {
            BrandSecondaryButton(
                text = stringResource(R.string.community_refresh),
                modifier = Modifier.weight(1f),
                onClick = actions.refresh,
            )
            BrandSecondaryButton(
                text = stringResource(R.string.community_back),
                modifier = Modifier.weight(1f),
                onClick = actions.close,
            )
        }
    }
}

@Composable
private fun ColumnScope.Ready(
    state: CommunityInsightsViewModel.State,
    data: CommunityBenchmarks,
    onOpenBrand: (String) -> Unit,
) {
    val pairItem = stringResource(R.string.community_pair_spoken_item)
    LazyColumn(
        Modifier.fillMaxWidth().weight(1f),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        item { YouCard(state, data) }

        if (!state.hasBenchmarkData) {
            item {
                InfoCard(
                    stringResource(R.string.community_not_enough_community_data_yet),
                    stringResource(R.string.community_too_thin),
                )
            }
        } else if (state.hasDataButNothingActionable) {
            item {
                InfoCard(
                    stringResource(R.string.community_nothing_act_right_now),
                    // Distinct from the message above on purpose: there IS
                    // community data, it just isn't telling you to do anything.
                    stringResource(R.string.community_nothing_actionable),
                )
            }
        }

        if (state.recommendations.isNotEmpty()) {
            item { SectionHeader(stringResource(R.string.community_what_numbers_suggest)) }
            items(state.recommendations, key = { it.id }) { rec ->
                RecommendationCard(rec, onOpenBrand)
            }
        }

        if (data.topBrands.isNotEmpty()) {
            item { SectionHeader(stringResource(R.string.community_sell_through_by_brand)) }
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
                        description = stringResource(
                            R.string.community_sell_through_spoken,
                            data.topBrands.take(8).joinToString {
                                pairItem.format(it.brand, Money.formatPercent(it.sellThrough))
                            },
                        ),
                    )
                }
            }
            item { SectionHeader(stringResource(R.string.community_average_sale_price)) }
            items(data.topBrands.take(8), key = { "price-${it.brand}" }) { brand ->
                BrandPriceRow(brand, onOpenBrand)
            }
        }

        if (data.trendingCategories.isNotEmpty()) {
            item { SectionHeader(stringResource(R.string.community_categories_move)) }
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
        Text(stringResource(R.string.community_text), style = MaterialTheme.typography.titleMedium)
        Text(
            stringResource(R.string.community_you_row, data.you.listed, data.you.sold),
            style = MaterialTheme.typography.bodyLarge,
        )
        val standing = state.peerStanding
        Text(
            standing ?: state.peerBlocker?.let { stringResource(it) }.orEmpty(),
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
private fun RecommendationCard(rec: CommunityRecommendation, onOpenBrand: (String) -> Unit) {
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
                rec.title.text(),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f),
            )
            AssistChip(onClick = {}, label = { Text(stringResource(rec.confidenceLevel.label)) })
        }
        Text(
            rec.detail.text(),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (rec.brandFilter != null) {
            Text(
                stringResource(R.string.community_tap_to_see, rec.subject),
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
                stringResource(
                    R.string.community_brand_row,
                    brand.sellers,
                    brand.sold,
                    brand.listed,
                ),
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
                // Two whole sentences rather than a spliced up/down: the verb does not
                // sit in the same place in every language.
                pluralStringResource(
                    if (it >= 0) R.plurals.community_trend_up else R.plurals.community_trend_down,
                    trend.sellers,
                    Money.formatPercent(kotlin.math.abs(it)),
                    trend.sellers,
                )
            }
                // No prior-period sales means there is no growth figure. Showing
                // "up 0%" would state a fact nobody measured.
                ?: stringResource(
                    R.string.community_trend_flat,
                    trend.soldRecent,
                    trend.sellers,
                ),
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
