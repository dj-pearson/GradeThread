package com.gradethread.app.radar

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.R
import com.gradethread.app.money.Money
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-2495: which shops actually make money.
 *
 * Every figure here is the server's. ROI and sell-through are read, never
 * recomputed on the phone: they come from the same item + listing + sale join
 * the rest of FlipDesk reports from, and a second definition of profit would
 * give one shop two different numbers depending on which screen you opened.
 */
@Composable
fun MyStoresScreen(onClose: () -> Unit = {}, viewModel: MyStoresViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()
    LaunchedEffect(Unit) { viewModel.load() }

    MyStoresContent(
        state = state,
        actions = MyStoresActions(
            sortBy = viewModel::sortBy,
            retry = viewModel::load,
            close = onClose,
        ),
    )
}

/**
 * Everything the stores list can do (US-2902 AC3).
 *
 * `retry` and the wrapper's LaunchedEffect are the same load(): it is both the
 * entry fetch and the error state's retry. THIRD screen in this sweep with that
 * shape, after ConsignmentReport and ListingPerformance, and all three were
 * caught by asserting the extracted body names no ViewModel.
 */
@Immutable
data class MyStoresActions(
    val sortBy: (StoreSort) -> Unit = {},
    val retry: () -> Unit = {},
    val close: () -> Unit = {},
)

/**
 * Which sourcing stores actually pay, with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ THIS SCREEN TELLS A SELLER WHERE TO SPEND THEIR SATURDAY. The rows are
 * ranked by what each store has returned, so a sort that silently stops applying
 * does not look broken - it looks like a different answer, and they drive to the
 * wrong shop. The sort chips and the row order are captured together for that
 * reason.
 */
@Composable
fun MyStoresContent(state: MyStoresViewModel.State, actions: MyStoresActions, modifier: Modifier = Modifier) {
    Column(
        modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(stringResource(R.string.stores_title), style = MaterialTheme.typography.titleLarge)
        Text(
            stringResource(R.string.stores_subtitle),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
            for (sort in StoreSort.entries) {
                FilterChip(
                    selected = state.sort == sort,
                    onClick = { actions.sortBy(sort) },
                    enabled = !state.loading,
                    label = { Text(sortLabel(sort)) },
                )
            }
        }

        state.errorMessage?.let { message ->
            Column(Modifier.fillMaxWidth().cardStyle()) {
                Text(
                    message,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                )
                TextButton(onClick = { actions.retry() }) {
                    Text(stringResource(R.string.common_try_again))
                }
            }
        }

        if (state.loading && state.stores == null) {
            Row(
                Modifier.fillMaxWidth().padding(Spacing.md),
                horizontalArrangement = Arrangement.Center,
            ) { CircularProgressIndicator() }
        }

        if (state.isEmpty) {
            Text(
                stringResource(R.string.stores_empty),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth().cardStyle(),
            )
        }

        LazyColumn(
            Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(Spacing.xs),
        ) {
            items(state.rows, key = { it.key }) { store -> StoreCard(store) }

            state.stores?.let { stores ->
                // Said out loud rather than implied away. A seller comparing
                // two shops needs to know one of them may be missing items.
                if (!state.isComplete) {
                    item {
                        Text(
                            stringResource(R.string.stores_truncated),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                if (stores.unattributedItems > 0 || stores.unplacedVisits > 0) {
                    item {
                        Text(
                            stringResource(
                                R.string.stores_unattributed,
                                stores.unattributedItems,
                                stores.unplacedVisits,
                            ),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }

        BrandSecondaryButton(
            text = stringResource(R.string.common_back),
            modifier = Modifier.fillMaxWidth(),
        ) { actions.close() }
    }
}

@Composable
private fun sortLabel(sort: StoreSort): String = stringResource(
    when (sort) {
        StoreSort.PROFIT -> R.string.stores_sort_profit
        StoreSort.ROI -> R.string.stores_sort_roi
        StoreSort.ITEMS -> R.string.stores_sort_items
        StoreSort.RECENT -> R.string.stores_sort_recent
    },
)

@Composable
private fun StoreCard(store: MyStore) {
    Column(Modifier.fillMaxWidth().cardStyle()) {
        Text(
            store.name,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
        )
        store.location?.takeIf { it.isNotBlank() }?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Text(
            stringResource(
                R.string.stores_money,
                Money.format(MyStoresRules.dollars(store.spendCents)),
                Money.format(MyStoresRules.dollars(store.realizedProfitCents)),
            ),
            style = MaterialTheme.typography.bodySmall,
        )

        // Absent, not zero. The server sends null for "nothing has sold yet",
        // and printing 0% would report a shop that has not had a chance as a
        // shop that failed.
        if (MyStoresRules.hasFigure(store.realizedRoiPct)) {
            Text(
                stringResource(R.string.stores_roi, MyStoresRules.percent(store.realizedRoiPct!!)),
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Text(
            stringResource(R.string.stores_counts, store.itemsSourced, store.itemsSold),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
