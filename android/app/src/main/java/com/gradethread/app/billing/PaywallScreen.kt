package com.gradethread.app.billing

import android.app.Activity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AssistChip
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.marketplaces.CustomTabsLauncher
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-1367: the paywall — plans, then credits.
 *
 * Prices come from Play when Play answers and from the server catalog when it
 * doesn't, so the screen always renders something honest rather than an empty
 * list with a spinner on it.
 */
@Composable
fun PaywallScreen(
    onClose: () -> Unit = {},
    viewModel: PaywallViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val context = LocalContext.current
    val activity = context as? Activity
    LaunchedEffect(Unit) { viewModel.load() }

    Column(
        Modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text("Plans", style = MaterialTheme.typography.titleLarge)
        state.currentPlan?.let {
            Text(
                "You're on ${it.label}.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        state.conflict?.let { conflict ->
            InfoCard("Already subscribed", conflict.message, tone = InfoTone.Warning)
            if (conflict.routesToWeb) {
                BrandSecondaryButton(
                    text = "Open web billing",
                    modifier = Modifier.fillMaxWidth(),
                ) { CustomTabsLauncher.open(context, viewModel.webBillingUrl()) }
            }
        }
        if (state.conflict == null) {
            state.errorMessage?.let {
                InfoCard("That didn't work", it, tone = InfoTone.Error)
            }
        }

        IntervalToggle(state, viewModel::setInterval)

        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            items(state.rows, key = { it.offer.product.productId }) { row ->
                TierCard(
                    row = row,
                    busy = state.purchasing,
                    onSubscribe = { activity?.let { viewModel.subscribe(it, row) } },
                )
            }

            item {
                Text(
                    "Grading credits",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(top = Spacing.sm),
                )
            }
            item {
                Text(
                    // Says what a credit pack is FOR, because the difference
                    // between a plan and a pack is not obvious from two prices.
                    "One-time packs. They never expire and stack on top of the " +
                        "grades your plan includes.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            items(state.creditPacks, key = { it.pack.productId }) { offer ->
                CreditRow(
                    offer = offer,
                    onBuy = { activity?.let { viewModel.buyCredits(it, offer.pack) } },
                )
            }
        }

        // The recovery path for a purchase that was paid for and never landed —
        // without it that money is invisible and the seller has no move.
        BrandSecondaryButton(
            text = "I already paid",
            modifier = Modifier.fillMaxWidth(),
        ) { viewModel.restore() }
        BrandSecondaryButton(text = "Close", modifier = Modifier.fillMaxWidth()) { onClose() }
    }
}

@Composable
private fun IntervalToggle(
    state: PaywallViewModel.State,
    onPick: (SubscriptionInterval) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SubscriptionInterval.entries.forEach { option ->
            FilterChip(
                selected = option == state.interval,
                onClick = { onPick(option) },
                label = { Text(option.label) },
            )
        }
        state.yearlyPitch?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.primary,
            )
        }
    }
}

@Composable
private fun TierCard(
    row: PaywallPricing.TierRow,
    busy: Boolean,
    onSubscribe: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                row.plan.label,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f),
            )
            row.savingsPercent?.let {
                AssistChip(onClick = {}, label = { Text("Save $it%") })
            }
        }
        Text(PaywallPricing.priceLine(row), style = MaterialTheme.typography.bodyLarge)
        PaywallPricing.monthlyEquivalent(row)?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        val blocked = PaywallPricing.blockedReason(row)
        if (blocked != null) {
            // Named, not greyed out in silence: "your current plan" and "Play
            // can't sell this" are very different pieces of news.
            Text(
                blocked,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            BrandPrimaryButton(
                text = if (busy) "Opening Google Play…" else "Choose ${row.plan.label}",
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
            ) { onSubscribe() }
        }
    }
}

@Composable
private fun CreditRow(offer: CreditPackOffer, onBuy: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().cardStyle(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(offer.pack.label, style = MaterialTheme.typography.bodyLarge)
            Text(
                offer.priceLabel,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        TextButton(onClick = onBuy) { Text("Buy") }
    }
}
