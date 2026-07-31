package com.gradethread.app.inventory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import com.gradethread.app.R
import com.gradethread.app.capture.CurrencyAmount
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import java.util.Locale

/**
 * US-1346: eBay comps plus the seller's own saved comparables.
 */
@Composable
fun CompsSection(
    state: CompsState,
    savedComps: List<ItemComp>,
    onFetch: () -> Unit,
    onUseMedian: (Double) -> Unit,
    onAddComp: (ItemComp) -> Unit,
    onRemoveComp: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
        Text(
            stringResource(R.string.comps_title),
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
        )

        when (state) {
            CompsState.Idle -> BrandSecondaryButton(
                text = stringResource(R.string.comps_fetch),
                modifier = Modifier.fillMaxWidth(),
            ) { onFetch() }

            CompsState.Loading -> Text(
                stringResource(R.string.comps_checking),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            // Deliberately distinct from NoCategory: this one is worth
            // retrying in a minute, and that one never will be.
            CompsState.Degraded -> Retryable(
                message = "eBay's category service is having trouble right now. " +
                    "Nothing's wrong with your item — try again shortly.",
                onRetry = onFetch,
            )

            CompsState.NoCategory -> Retryable(
                message = "Couldn't match this item to an eBay category. A more specific " +
                    "title (brand and garment type) usually fixes it.",
                onRetry = onFetch,
                retryLabel = "Try again",
            )

            is CompsState.Failed -> Retryable(message = state.message, onRetry = onFetch)

            is CompsState.Loaded -> LoadedComps(state.lookup, onFetch, onUseMedian)
        }

        SavedComps(savedComps, onAddComp, onRemoveComp)
    }
}

@Composable
private fun LoadedComps(
    lookup: CompsLookup,
    onRefresh: () -> Unit,
    onUseMedian: (Double) -> Unit,
) {
    val stats = lookup.stats
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
        // The category is shown, not hidden: a comp range drawn from the wrong
        // category is worse than no range at all, and only the seller can tell.
        Text(
            lookup.categoryPath,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        if (stats.count == 0) {
            Text(
                stringResource(R.string.comps_none_found),
                style = MaterialTheme.typography.bodySmall,
            )
        } else {
            Text(
                pluralStringResource(
                    R.plurals.comps_count,
                    stats.count,
                    stats.count,
                    listOfNotNull(
                        stats.p25?.let {
                            stringResource(R.string.comps_p25, money(it, stats.currency))
                        },
                        stats.median?.let {
                            stringResource(R.string.comps_median, money(it, stats.currency))
                        },
                        stats.p75?.let {
                            stringResource(R.string.comps_p75, money(it, stats.currency))
                        },
                    ).joinToString(" · ").ifEmpty { stringResource(R.string.comps_no_percentiles) },
                ),
                style = MaterialTheme.typography.bodyMedium,
            )
        }

        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            if (stats.hasMedian) {
                // Gated on hasMedian, not count: every percentile is
                // independently nullable, so a result can report comps and
                // still have no median to apply.
                BrandSecondaryButton(
                    text = stringResource(R.string.comps_use_median),
                    modifier = Modifier.weight(1f),
                ) { onUseMedian(stats.median!!) }
            }
            TextButton(onClick = onRefresh) { Text(stringResource(R.string.common_refresh)) }
        }
    }
}

@Composable
private fun Retryable(
    message: String,
    onRetry: () -> Unit,
    retryLabel: String = stringResource(R.string.common_try_again),
) {
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
        Text(
            message,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        TextButton(onClick = onRetry) { Text(retryLabel) }
    }
}

@Composable
private fun SavedComps(
    comps: List<ItemComp>,
    onAdd: (ItemComp) -> Unit,
    onRemove: (Int) -> Unit,
) {
    var priceText by remember { mutableStateOf("") }
    var source by remember { mutableStateOf("") }

    Column(verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
        Text(
            stringResource(R.string.comps_saved_title),
            style = MaterialTheme.typography.labelMedium,
        )

        comps.forEachIndexed { index, comp ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    buildString {
                        append(CurrencyAmount.SYMBOL)
                        append(CurrencyAmount.formatRaw(Math.round(comp.price * 100)))
                        comp.source?.takeIf { it.isNotBlank() }?.let { append(" · $it") }
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { onRemove(index) }) {
                    Text(stringResource(R.string.common_remove))
                }
            }
        }

        CompSet.median(comps)?.let { median ->
            Text(
                stringResource(
                    R.string.comps_your_median,
                    CurrencyAmount.SYMBOL + CurrencyAmount.formatRaw(Math.round(median * 100)),
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = priceText,
                onValueChange = { priceText = it },
                label = { Text(stringResource(R.string.common_price)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                modifier = Modifier.weight(1f),
            )
            OutlinedTextField(
                value = source,
                onValueChange = { source = it },
                label = { Text(stringResource(R.string.comps_source_optional)) },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
        }
        TextButton(
            onClick = {
                CurrencyAmount.parseCents(priceText)?.takeIf { it > 0 }?.let { cents ->
                    onAdd(
                        ItemComp(
                            price = cents / 100.0,
                            source = source.trim().ifBlank { null },
                        ),
                    )
                    priceText = ""
                    source = ""
                }
            },
            // A comp with no price is not a comp.
            enabled = (CurrencyAmount.parseCents(priceText) ?: 0L) > 0L,
        ) { Text(stringResource(R.string.comps_add)) }
    }
}

private fun money(value: Double, currency: String): String {
    val formatted = String.format(Locale.US, "%,.2f", value)
    return if (currency == "USD") "${CurrencyAmount.SYMBOL}$formatted" else "$formatted $currency"
}
