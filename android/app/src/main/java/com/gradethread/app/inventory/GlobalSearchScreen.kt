package com.gradethread.app.inventory

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.capture.CurrencyAmount
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1349: search across inventory, listings, sales and sources.
 */
@Composable
fun GlobalSearchScreen(
    onOpen: (String) -> Unit,
    modifier: Modifier = Modifier,
    viewModel: GlobalSearchViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()

    GlobalSearchContent(
        state = state,
        actions = GlobalSearchActions(
            setQuery = viewModel::setQuery,
            clear = viewModel::clear,
            open = onOpen,
        ),
        modifier = modifier,
    )
}

/** Everything search can do (US-2902 AC3). */
@Immutable
data class GlobalSearchActions(
    val setQuery: (String) -> Unit = {},
    val clear: () -> Unit = {},
    val open: (String) -> Unit = {},
)

/**
 * Search across everything, with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ THREE EMPTY-LOOKING STATES MEAN DIFFERENT THINGS, and the state class keeps
 * them apart on purpose: `tooShort` (the query is not long enough to run),
 * `hasSearched` false (nothing has been asked yet), and `hasSearched` true with
 * no results (we looked and there is nothing). All three render a screen with no
 * rows on it, and telling a seller "no matches" when the truth is "type another
 * letter" is the one that wastes their time.
 */
@Composable
fun GlobalSearchContent(
    state: GlobalSearchViewModel.State,
    actions: GlobalSearchActions,
    modifier: Modifier = Modifier,
) {
    val results = state.results

    Column(modifier.fillMaxSize().padding(Spacing.md)) {
        OutlinedTextField(
            value = state.query,
            onValueChange = actions.setQuery,
            label = { Text(stringResource(R.string.search_search_inventory_listings_sales_sources)) },
            singleLine = true,
            trailingIcon = {
                if (state.query.isNotEmpty()) {
                    TextButton(onClick = actions.clear) { Text(stringResource(R.string.search_clear)) }
                }
            },
            modifier = Modifier.fillMaxWidth(),
        )

        when {
            state.tooShort ->
                Hint(stringResource(R.string.search_keep_typing, GlobalSearch.MIN_QUERY_LENGTH))

            state.query.isBlank() ->
                Hint(stringResource(R.string.search_hint))

            state.searching && results.isEmpty -> Hint(stringResource(R.string.search_searching))

            state.hasSearched && results.isEmpty -> Hint(
                stringResource(R.string.search_no_results),
            )

            else -> LazyColumn(Modifier.fillMaxSize()) {
                if (results.items.isNotEmpty()) {
                    item {
                        SectionHeader(stringResource(R.string.search_items, results.items.size))
                    }
                    items(results.items, key = { "item-${it.id}" }) { item ->
                        ResultRow(
                            title = item.title,
                            subtitle = listOfNotNull(item.brand, item.sku, item.size)
                                .filter { it.isNotBlank() }
                                .joinToString(" · ")
                                .ifEmpty { item.status },
                        ) {
                            actions.open(GlobalSearch.routeFor(GlobalSearch.Kind.ITEM, item.id))
                        }
                    }
                }

                if (results.listings.isNotEmpty()) {
                    item {
                        SectionHeader(stringResource(R.string.search_listings, results.listings.size))
                    }
                    items(results.listings, key = { "listing-${it.listing.id}" }) { hit ->
                        ResultRow(
                            title = hit.item.title,
                            subtitle = stringResource(
                                R.string.search_listing_subtitle,
                                hit.listing.platform,
                                hit.listing.listingStatus,
                                money(hit.listing.listingPrice),
                            ),
                        ) {
                            actions.open(GlobalSearch.routeFor(GlobalSearch.Kind.LISTING, hit.item.id))
                        }
                    }
                }

                if (results.sales.isNotEmpty()) {
                    item {
                        SectionHeader(stringResource(R.string.search_sales, results.sales.size))
                    }
                    items(results.sales, key = { "sale-${it.sale.id}" }) { hit ->
                        ResultRow(
                            title = hit.item.title,
                            subtitle = listOfNotNull(
                                hit.sale.buyerUsername?.takeIf { it.isNotBlank() },
                                money(hit.sale.salePrice),
                            ).joinToString(" · "),
                        ) {
                            actions.open(GlobalSearch.routeFor(GlobalSearch.Kind.SALE, hit.item.id))
                        }
                    }
                }

                if (results.sources.isNotEmpty()) {
                    item {
                        SectionHeader(stringResource(R.string.search_sources, results.sources.size))
                    }
                    items(results.sources, key = { "source-${it.id}" }) { source ->
                        ResultRow(
                            title = source.name,
                            subtitle = listOfNotNull(source.sourceType, source.notes)
                                .filter { it.isNotBlank() }
                                .joinToString(" · "),
                        ) {
                            actions.open(GlobalSearch.routeFor(GlobalSearch.Kind.SOURCE, source.id))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionHeader(text: String) {
    Column {
        HorizontalDivider(Modifier.padding(vertical = Spacing.xxs))
        Text(
            text,
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun ResultRow(title: String, subtitle: String, onClick: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = Spacing.xs),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Text(title, style = MaterialTheme.typography.bodyMedium)
        Text(
            subtitle.ifEmpty { "—" },
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun Hint(text: String) {
    Column(
        Modifier.fillMaxSize().padding(Spacing.xl),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

private fun money(value: Double): String = CurrencyAmount.SYMBOL + CurrencyAmount.formatRaw(Math.round(value * 100))
