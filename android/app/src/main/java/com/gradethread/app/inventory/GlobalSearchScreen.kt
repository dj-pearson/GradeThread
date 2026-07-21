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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
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
    val results = state.results

    Column(modifier.fillMaxSize().padding(Spacing.md)) {
        OutlinedTextField(
            value = state.query,
            onValueChange = viewModel::setQuery,
            label = { Text("Search inventory, listings, sales, sources") },
            singleLine = true,
            trailingIcon = {
                if (state.query.isNotEmpty()) {
                    TextButton(onClick = viewModel::clear) { Text("Clear") }
                }
            },
            modifier = Modifier.fillMaxWidth(),
        )

        when {
            state.tooShort ->
                Hint("Keep typing — ${GlobalSearch.MIN_QUERY_LENGTH} characters minimum.")

            state.query.isBlank() ->
                Hint("Search by title, brand, SKU, size, colour, buyer or source.")

            state.searching && results.isEmpty -> Hint("Searching…")

            state.hasSearched && results.isEmpty -> Hint(
                "Nothing matched that. Results come from what's synced to this device, " +
                    "so a very new item may not be here yet.",
            )

            else -> LazyColumn(Modifier.fillMaxSize()) {
                if (results.items.isNotEmpty()) {
                    item { SectionHeader("Items (${results.items.size})") }
                    items(results.items, key = { "item-${it.id}" }) { item ->
                        ResultRow(
                            title = item.title,
                            subtitle = listOfNotNull(item.brand, item.sku, item.size)
                                .filter { it.isNotBlank() }
                                .joinToString(" · ")
                                .ifEmpty { item.status },
                        ) {
                            onOpen(GlobalSearch.routeFor(GlobalSearch.Kind.ITEM, item.id))
                        }
                    }
                }

                if (results.listings.isNotEmpty()) {
                    item { SectionHeader("Listings (${results.listings.size})") }
                    items(results.listings, key = { "listing-${it.listing.id}" }) { hit ->
                        ResultRow(
                            title = hit.item.title,
                            subtitle = "${hit.listing.platform} · ${hit.listing.listingStatus}" +
                                " · ${money(hit.listing.listingPrice)}",
                        ) {
                            onOpen(GlobalSearch.routeFor(GlobalSearch.Kind.LISTING, hit.item.id))
                        }
                    }
                }

                if (results.sales.isNotEmpty()) {
                    item { SectionHeader("Sales (${results.sales.size})") }
                    items(results.sales, key = { "sale-${it.sale.id}" }) { hit ->
                        ResultRow(
                            title = hit.item.title,
                            subtitle = listOfNotNull(
                                hit.sale.buyerUsername?.takeIf { it.isNotBlank() },
                                money(hit.sale.salePrice),
                            ).joinToString(" · "),
                        ) {
                            onOpen(GlobalSearch.routeFor(GlobalSearch.Kind.SALE, hit.item.id))
                        }
                    }
                }

                if (results.sources.isNotEmpty()) {
                    item { SectionHeader("Sources (${results.sources.size})") }
                    items(results.sources, key = { "source-${it.id}" }) { source ->
                        ResultRow(
                            title = source.name,
                            subtitle = listOfNotNull(source.sourceType, source.notes)
                                .filter { it.isNotBlank() }
                                .joinToString(" · "),
                        ) {
                            onOpen(GlobalSearch.routeFor(GlobalSearch.Kind.SOURCE, source.id))
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

private fun money(value: Double): String =
    CurrencyAmount.SYMBOL + CurrencyAmount.formatRaw(Math.round(value * 100))
