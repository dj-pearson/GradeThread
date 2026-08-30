package com.gradethread.app.marketplaces.pricing

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.money.Money
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-1355: bulk price editor — pick listings, choose an adjustment, see the new
 * price on every row before anything is pushed.
 */
@Composable
fun BulkPricingScreen(onClose: () -> Unit = {}, viewModel: BulkPricingViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()
    LaunchedEffect(Unit) { viewModel.load() }

    BulkPricingContent(
        state = state,
        actions = BulkPricingActions(
            setMode = viewModel::setMode,
            setInput = viewModel::setInput,
            toggle = viewModel::toggle,
            toggleAll = viewModel::toggleAll,
            apply = viewModel::apply,
            close = onClose,
        ),
    )
}

/**
 * Everything bulk pricing can do (US-2902 AC3).
 *
 * `load` stays with the wrapper: it is a LaunchedEffect on entry, not a control.
 */
@Immutable
data class BulkPricingActions(
    val setMode: (BulkPricing.Mode) -> Unit = {},
    val setInput: (String) -> Unit = {},
    val toggle: (String) -> Unit = {},
    val toggleAll: () -> Unit = {},
    val apply: () -> Unit = {},
    val close: () -> Unit = {},
)

/**
 * Repricing many listings at once, with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ THE PREVIEW IS THE SAFETY FEATURE. Every other screen in this sweep shows a
 * seller what already happened; this one shows what is ABOUT to happen to a
 * whole page of live prices, and then does it in one press. The per-row new
 * price and the rowErrors beside it are the only thing between a mistyped
 * percentage and every listing being repriced wrongly at once.
 *
 * So the captures include a row that FAILED validation next to rows that
 * passed. A screen that quietly stopped rendering rowErrors would look
 * completely normal.
 */
@Composable
fun BulkPricingContent(state: BulkPricingViewModel.State, actions: BulkPricingActions, modifier: Modifier = Modifier) {
    Column(
        modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(stringResource(R.string.bulkpricing_bulk_pricing), style = MaterialTheme.typography.titleLarge)

        BulkPricingNotices(state)

        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
            BulkPricing.Mode.entries.forEach { mode ->
                FilterChip(
                    selected = state.mode == mode,
                    onClick = { actions.setMode(mode) },
                    label = { Text(mode.label) },
                )
            }
        }

        if (state.mode != BulkPricing.Mode.NONE) {
            OutlinedTextField(
                value = state.inputText,
                onValueChange = actions.setInput,
                label = {
                    Text(
                        stringResource(
                            if (state.mode == BulkPricing.Mode.SET) {
                                R.string.bulkpricing_new_price
                            } else {
                                R.string.bulkpricing_reduce_by
                            },
                        ),
                    )
                },
                prefix = {
                    if (state.mode == BulkPricing.Mode.SET) {
                        Text(stringResource(R.string.drafts_currency_prefix))
                    }
                },
                suffix = { if (state.mode == BulkPricing.Mode.REDUCE) Text(stringResource(R.string.bulkpricing_text)) },
                singleLine = true,
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                    keyboardType = KeyboardType.Decimal,
                ),
                modifier = Modifier.fillMaxWidth(),
            )
            if (state.inputText.isNotBlank() && state.value == null) {
                Text(
                    if (state.mode == BulkPricing.Mode.SET) {
                        stringResource(R.string.bulkpricing_price_invalid)
                    } else {
                        stringResource(R.string.bulkpricing_reduction_invalid)
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }

        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                stringResource(
                    R.string.bulkpricing_selected_of,
                    state.selected.size,
                    state.listings.size,
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = actions.toggleAll) {
                Text(
                    stringResource(
                        if (state.allSelected) {
                            R.string.drafts_clear_all
                        } else {
                            R.string.drafts_select_all
                        },
                    ),
                )
            }
        }

        when {
            state.loading -> Text(
                stringResource(R.string.bulkpricing_loading_live_listings),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            state.listings.isEmpty() -> Text(
                stringResource(R.string.bulkpricing_empty),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            else -> LazyColumn(
                Modifier.fillMaxWidth().weight(1f),
                verticalArrangement = Arrangement.spacedBy(Spacing.xs),
            ) {
                items(state.listings, key = { it.id }) { listing ->
                    ListingRow(
                        listing = listing,
                        selected = listing.id in state.selected,
                        target = state.target(listing),
                        rowError = state.rowErrors[listing.id],
                        onToggle = { actions.toggle(listing.id) },
                    )
                }
            }
        }

        BrandPrimaryButton(
            text = when {
                state.busy -> stringResource(R.string.bulkpricing_pushing)
                state.updates.isEmpty() -> stringResource(R.string.bulkpricing_nothing_to_push)
                else -> pluralStringResource(
                    R.plurals.bulkpricing_push_count,
                    state.updates.size,
                    state.updates.size,
                )
            },
            enabled = state.canApply,
            modifier = Modifier.fillMaxWidth(),
        ) { actions.apply() }

        BrandSecondaryButton(text = stringResource(R.string.bulkpricing_back), modifier = Modifier.fillMaxWidth()) {
            actions.close()
        }
    }
}

@Composable
private fun ListingRow(
    listing: BulkListing,
    selected: Boolean,
    target: BulkPricing.Target,
    rowError: String?,
    onToggle: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Checkbox(checked = selected, onCheckedChange = { onToggle() })
            Text(
                listing.title,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                modifier = Modifier.weight(1f),
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(Money.format(listing.price), style = MaterialTheme.typography.bodyMedium)
            // The preview only shows for selected rows: an unselected row isn't
            // going anywhere, and showing it a new price implies otherwise.
            if (selected) {
                target.price?.let {
                    Text(
                        stringResource(R.string.bulkpricing_arrow, Money.format(it)),
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            }
            listing.quantity?.let {
                Text(
                    stringResource(R.string.bulkpricing_qty, it),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (selected) {
            target.error?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
        rowError?.let {
            // A per-listing failure from the last push. It stays on its row so a
            // partial batch reads as "these two didn't", not "it failed".
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

/**
 * The three banners above the editor, lifted out of BulkPricingContent.
 *
 * Not a style choice: with them inline the content function sat AT detekt's
 * cyclomatic ceiling of 20 and the build failed. AuthScreen's SignUpCaptcha was
 * carved off for the same reason and its comment says so - holding a condition
 * beside the thing it decides keeps the caller a plain call.
 *
 * ⚠ THE MULTI-STORE ONE IS NOT COSMETIC (US-1216). Every push routes through
 * the PRIMARY store's token and the listing rows record no store of their own,
 * so a two-store seller who does not see this line reprices the wrong shop with
 * nothing on screen to say so.
 */
@Composable
private fun BulkPricingNotices(state: BulkPricingViewModel.State) {
    val primaryStoreFallback = stringResource(R.string.bulkpricing_primary_store_fallback)

    if (state.multiStore) {
        InfoCard(
            stringResource(
                R.string.bulkpricing_pushing_through,
                state.primaryStoreName ?: primaryStoreFallback,
            ),
            stringResource(R.string.bulkpricing_multi_account),
        )
    }

    state.errorMessage?.let {
        InfoCard(stringResource(R.string.bulkpricing_that_didn_t_work), it, tone = InfoTone.Error)
    }
    state.banner?.let {
        InfoCard(stringResource(R.string.bulkpricing_pushed), it, tone = InfoTone.Success)
    }
}
