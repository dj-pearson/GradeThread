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
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.R
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
fun PaywallScreen(onClose: () -> Unit = {}, viewModel: PaywallViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()
    val context = LocalContext.current
    val activity = context as? Activity
    LaunchedEffect(Unit) { viewModel.load() }

    PaywallContent(
        state,
        PaywallActions(
            setInterval = viewModel::setInterval,
            // The Activity and the Context both stay in the wrapper. Play
            // billing needs a real Activity to launch its flow, and a
            // screenshot test has neither.
            subscribe = { row -> activity?.let { viewModel.subscribe(it, row) } },
            buyCredits = { pack -> activity?.let { viewModel.buyCredits(it, pack) } },
            openWebBilling = { CustomTabsLauncher.open(context, viewModel.webBillingUrl()) },
            manageSubscription = {
                CustomTabsLauncher.open(context, PaywallViewModel.MANAGE_SUBSCRIPTIONS_URL)
            },
            restore = viewModel::restore,
            close = onClose,
        ),
    )
}

/** Everything this screen can be asked to do (US-2902 AC3). */
@Immutable
data class PaywallActions(
    val setInterval: (SubscriptionInterval) -> Unit = {},
    val subscribe: (PaywallPricing.TierRow) -> Unit = {},
    val buyCredits: (CreditPack) -> Unit = {},
    val openWebBilling: () -> Unit = {},
    /**
     * Deep-links to THIS app subscription entry rather than the account-wide
     * Play list: "find it in the Play Store" is not a route.
     */
    val manageSubscription: () -> Unit = {},
    val restore: () -> Unit = {},
    val close: () -> Unit = {},
)

/**
 * The paywall with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ THE AUTO-RENEWAL DISCLOSURE HAS A POSITION, NOT JUST A PRESENCE. US-2126
 * put it directly under the tiers and above the credit packs, because it has to
 * sit where the subscribing happens rather than at the bottom of a scroll. A
 * capture is the only thing that can check where a paragraph ended up.
 *
 * ⚠ AND A CONFLICT REPLACES THE ERROR, on purpose. When Play reports an
 * existing subscription the screen shows a WARNING with the conflict message
 * and suppresses the ordinary error - two red cards about the same thing would
 * read as two separate problems.
 *
 * ⚠ THE RESTORE BUTTON IS THE RECOVERY PATH for a purchase that was paid for
 * and never landed. Without it that money is invisible and the seller has no
 * move, so it renders in every state including the failures.
 */
@Composable
fun PaywallContent(state: PaywallViewModel.State, actions: PaywallActions, modifier: Modifier = Modifier) {
    Column(
        modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(stringResource(R.string.paywall_title), style = MaterialTheme.typography.titleLarge)
        state.currentPlan?.let {
            Text(
                stringResource(R.string.paywall_current_plan, it.label),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        state.conflict?.let { conflict ->
            InfoCard(
                stringResource(R.string.paywall_already_subscribed),
                conflict.message,
                tone = InfoTone.Warning,
            )
            if (conflict.routesToWeb) {
                BrandSecondaryButton(
                    text = stringResource(R.string.paywall_open_web_billing),
                    modifier = Modifier.fillMaxWidth(),
                ) { actions.openWebBilling() }
            }
        }
        if (state.conflict == null) {
            state.errorMessage?.let {
                InfoCard(stringResource(R.string.common_that_didnt_work), it, tone = InfoTone.Error)
            }
        }

        IntervalToggle(state, actions.setInterval)

        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            items(state.rows, key = { it.offer.product.productId }) { row ->
                TierCard(
                    row = row,
                    busy = state.purchasing,
                    onSubscribe = { actions.subscribe(row) },
                )
            }

            // US-2126: the auto-renewal disclosure, directly under the tiers and
            // ABOVE the credit packs. Position is the point - it has to sit where
            // the subscribe decision is made, not at the bottom of a scroll under
            // one-time purchases it does not describe. Play Billing shipped
            // without this: a seller could subscribe from this screen with
            // nothing on it saying the plan renews.
            item {
                Text(
                    stringResource(
                        if (state.interval == SubscriptionInterval.YEARLY) {
                            R.string.paywall_renewal_yearly
                        } else {
                            R.string.paywall_renewal_monthly
                        },
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = Spacing.sm),
                )
            }
            item {
                // Play requires the cancel route to be reachable, and "go find it
                // in the Play Store" is not a route. Deep-links to this app's own
                // subscription entry rather than the account-wide list.
                TextButton(
                    onClick = actions.manageSubscription,
                ) {
                    Text(stringResource(R.string.paywall_manage_subscription))
                }
            }

            item {
                Text(
                    stringResource(R.string.paywall_credits_title),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(top = Spacing.sm),
                )
            }
            item {
                Text(
                    // Says what a credit pack is FOR, because the difference
                    // between a plan and a pack is not obvious from two prices.
                    stringResource(R.string.paywall_credits_body),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            items(state.creditPacks, key = { it.pack.productId }) { offer ->
                CreditRow(
                    offer = offer,
                    onBuy = { actions.buyCredits(offer.pack) },
                )
            }
        }

        // The recovery path for a purchase that was paid for and never landed —
        // without it that money is invisible and the seller has no move.
        BrandSecondaryButton(
            text = stringResource(R.string.paywall_already_paid),
            modifier = Modifier.fillMaxWidth(),
        ) { actions.restore() }
        BrandSecondaryButton(
            text = stringResource(R.string.common_close),
            modifier = Modifier.fillMaxWidth(),
        ) { actions.close() }
    }
}

@Composable
private fun IntervalToggle(state: PaywallViewModel.State, onPick: (SubscriptionInterval) -> Unit) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SubscriptionInterval.entries.forEach { option ->
            FilterChip(
                selected = option == state.interval,
                onClick = { onPick(option) },
                label = { Text(stringResource(option.label)) },
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
private fun TierCard(row: PaywallPricing.TierRow, busy: Boolean, onSubscribe: () -> Unit) {
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
                AssistChip(
                    onClick = {},
                    label = { Text(stringResource(R.string.paywall_save_percent, it)) },
                )
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
                text = if (busy) {
                    stringResource(R.string.credits_opening_play)
                } else {
                    stringResource(R.string.planstep_choose, row.plan.label)
                },
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
        TextButton(onClick = onBuy) { Text(stringResource(R.string.paywall_buy)) }
    }
}
