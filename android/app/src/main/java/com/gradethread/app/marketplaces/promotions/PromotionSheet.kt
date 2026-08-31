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
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.ui.text
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
            Text(stringResource(R.string.promotion_promote_discount), style = MaterialTheme.typography.titleLarge)
            Text(
                listingTitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            state.errorMessage?.let {
                InfoCard(stringResource(R.string.promotion_that_didn_t_work), it, tone = InfoTone.Error)
            }
            state.banner?.let { InfoCard(stringResource(R.string.promotion_done), it, tone = InfoTone.Success) }

            when {
                state.loading -> Text(
                    stringResource(R.string.promotion_loading),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                state.promotion == null -> Text(
                    stringResource(R.string.promotion_couldn_t_load_this_listing),
                    style = MaterialTheme.typography.bodyMedium,
                )

                else -> {
                    val promo = state.promotion!!
                    PromotionPanel(promo, state, viewModel)
                    SalePanel(promo, state, viewModel)
                }
            }

            BrandSecondaryButton(text = stringResource(R.string.promotion_close), modifier = Modifier.fillMaxWidth()) {
                onDismiss()
            }
        }
    }
}

@Composable
private fun PromotionPanel(promo: PromotionState, state: PromotionViewModel.State, viewModel: PromotionViewModel) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(stringResource(R.string.promotion_promoted_listing), style = MaterialTheme.typography.bodyLarge)
        Text(
            Promotions.promotionSummary(promo).text(),
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
            label = { Text(stringResource(R.string.promotion_ad_rate)) },
            suffix = { Text(stringResource(R.string.promotion_text)) },
            singleLine = true,
            enabled = !state.busy,
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                keyboardType = KeyboardType.Decimal,
            ),
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            stringResource(
                R.string.promotion_ad_rate_range,
                Promotions.formatPct(Promotions.MIN_AD_RATE_PCT),
                Promotions.formatPct(Promotions.MAX_AD_RATE_PCT),
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            BrandPrimaryButton(
                text = stringResource(
                    if (promo.effectivePromote) {
                        R.string.promotion_update_rate
                    } else {
                        R.string.promotion_promote
                    },
                ),
                enabled = !state.busy && state.rate != null,
                modifier = Modifier.weight(1f),
            ) { viewModel.promote() }
            if (promo.effectivePromote) {
                BrandSecondaryButton(
                    text = stringResource(R.string.promotion_stop),
                    enabled = !state.busy,
                    modifier = Modifier.weight(1f),
                ) { viewModel.stopPromoting() }
            }
        }
    }
}

@Composable
private fun SalePanel(promo: PromotionState, state: PromotionViewModel.State, viewModel: PromotionViewModel) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(stringResource(R.string.promotion_sale), style = MaterialTheme.typography.bodyLarge)
        Text(
            Promotions.saleSummary(promo).text(),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedTextField(
            value = state.saleText,
            onValueChange = viewModel::setSale,
            label = { Text(stringResource(R.string.promotion_percent_off)) },
            suffix = { Text(stringResource(R.string.promotion_text)) },
            singleLine = true,
            enabled = !state.busy,
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                keyboardType = KeyboardType.Decimal,
            ),
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            stringResource(
                R.string.promotion_markdown_range,
                Promotions.formatPct(Promotions.MIN_MARKDOWN_PCT),
                Promotions.formatPct(Promotions.MAX_MARKDOWN_PCT),
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            BrandPrimaryButton(
                text = stringResource(
                    if (promo.saleActive) R.string.promotion_update_sale else R.string.promotion_start_sale,
                ),
                enabled = !state.busy && state.salePercent != null,
                modifier = Modifier.weight(1f),
            ) { viewModel.startSale() }
            if (promo.saleActive) {
                BrandSecondaryButton(
                    text = stringResource(R.string.promotion_end_sale),
                    enabled = !state.busy,
                    modifier = Modifier.weight(1f),
                ) { viewModel.endSale() }
            }
        }
    }
}
