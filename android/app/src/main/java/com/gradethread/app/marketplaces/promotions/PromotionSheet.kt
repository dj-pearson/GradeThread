package com.gradethread.app.marketplaces.promotions

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-1357: promote a listing, or put it on sale, from one sheet.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PromotionSheet(
    listingId: String,
    listingTitle: String,
    onDismiss: () -> Unit,
    viewModel: PromotionViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    LaunchedEffect(listingId) { viewModel.bind(listingId) }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = Spacing.md)
                .padding(bottom = Spacing.lg),
            verticalArrangement = Arrangement.spacedBy(Spacing.sm),
        ) {
            Text("Promote or discount", style = MaterialTheme.typography.titleLarge)
            Text(
                listingTitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            state.errorMessage?.let { InfoCard("That didn't work", it, tone = InfoTone.Error) }
            state.banner?.let { InfoCard("Done", it, tone = InfoTone.Success) }

            when {
                state.loading -> Text(
                    "Loading…",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                state.promotion == null -> Text(
                    "Couldn't load this listing's promotion settings.",
                    style = MaterialTheme.typography.bodyMedium,
                )

                else -> {
                    val promo = state.promotion!!
                    PromotionPanel(promo, state, viewModel)
                    SalePanel(promo, state, viewModel)
                }
            }

            BrandSecondaryButton(text = "Close", modifier = Modifier.fillMaxWidth()) { onDismiss() }
        }
    }
}

@Composable
private fun PromotionPanel(
    promo: PromotionState,
    state: PromotionViewModel.State,
    viewModel: PromotionViewModel,
) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text("Promoted listing", style = MaterialTheme.typography.bodyLarge)
        Text(
            Promotions.promotionSummary(promo),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        promo.suggestionLabel?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        OutlinedTextField(
            value = state.rateText,
            onValueChange = viewModel::setRate,
            label = { Text("Ad rate") },
            suffix = { Text("%") },
            singleLine = true,
            enabled = !state.busy,
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                keyboardType = KeyboardType.Decimal,
            ),
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            "eBay accepts ${Promotions.formatPct(Promotions.MIN_AD_RATE_PCT)}–" +
                "${Promotions.formatPct(Promotions.MAX_AD_RATE_PCT)}%. " +
                "You only pay it when the ad makes the sale.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            BrandPrimaryButton(
                text = if (promo.effectivePromote) "Update rate" else "Promote",
                enabled = !state.busy && state.rate != null,
                modifier = Modifier.weight(1f),
            ) { viewModel.promote() }
            if (promo.effectivePromote) {
                BrandSecondaryButton(
                    text = "Stop",
                    enabled = !state.busy,
                    modifier = Modifier.weight(1f),
                ) { viewModel.stopPromoting() }
            }
        }
    }
}

@Composable
private fun SalePanel(
    promo: PromotionState,
    state: PromotionViewModel.State,
    viewModel: PromotionViewModel,
) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text("Sale", style = MaterialTheme.typography.bodyLarge)
        Text(
            Promotions.saleSummary(promo),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedTextField(
            value = state.saleText,
            onValueChange = viewModel::setSale,
            label = { Text("Percent off") },
            suffix = { Text("%") },
            singleLine = true,
            enabled = !state.busy,
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                keyboardType = KeyboardType.Decimal,
            ),
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            "eBay accepts ${Promotions.formatPct(Promotions.MIN_MARKDOWN_PCT)}–" +
                "${Promotions.formatPct(Promotions.MAX_MARKDOWN_PCT)}% off. " +
                "Ending the sale puts the original price back.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            BrandPrimaryButton(
                text = if (promo.saleActive) "Update sale" else "Start sale",
                enabled = !state.busy && state.salePercent != null,
                modifier = Modifier.weight(1f),
            ) { viewModel.startSale() }
            if (promo.saleActive) {
                BrandSecondaryButton(
                    text = "End sale",
                    enabled = !state.busy,
                    modifier = Modifier.weight(1f),
                ) { viewModel.endSale() }
            }
        }
    }
}
