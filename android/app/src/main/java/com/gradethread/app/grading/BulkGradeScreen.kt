package com.gradethread.app.grading

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.billing.CreditPackSheet
import com.gradethread.app.billing.TopUpSurface
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1339: grade a multi-selection (iOS `BulkGradeSheet`).
 */
@Composable
fun BulkGradeScreen(
    itemIds: List<String>,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
    viewModel: BulkGradeViewModel = hiltViewModel(),
) {
    LaunchedEffect(itemIds) { viewModel.bind(itemIds) }
    val state by viewModel.state.collectAsState()

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Text(
            pluralStringResource(R.plurals.bulkgrade_title, itemIds.size, itemIds.size),
            style = MaterialTheme.typography.titleLarge,
        )

        when (val phase = state.phase) {
            BulkGradeMachine.Phase.Loading -> Box(
                Modifier.fillMaxWidth().padding(Spacing.xl),
                contentAlignment = Alignment.Center,
            ) { CircularProgressIndicator() }

            BulkGradeMachine.Phase.Ready -> ReadyBody(state, viewModel)

            BulkGradeMachine.Phase.Submitting -> Box(
                Modifier.fillMaxWidth().padding(Spacing.xl),
                contentAlignment = Alignment.Center,
            ) { CircularProgressIndicator() }

            is BulkGradeMachine.Phase.Done -> Column(
                verticalArrangement = Arrangement.spacedBy(Spacing.xs),
            ) {
                Text(phase.summary.headline, style = MaterialTheme.typography.titleMedium)
                phase.summary.detail?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text(
                    stringResource(R.string.bulkgrade_grades_land_each_item_as),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                BrandPrimaryButton(text = stringResource(R.string.bulkgrade_done), modifier = Modifier.fillMaxWidth()) {
                    onClose()
                }
            }

            is BulkGradeMachine.Phase.Empty -> Column(
                verticalArrangement = Arrangement.spacedBy(Spacing.xs),
            ) {
                // No "Try again": an empty selection can never validate.
                Text(phase.message, style = MaterialTheme.typography.bodyMedium)
                BrandPrimaryButton(
                    text = stringResource(R.string.bulkgrade_close),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    onClose()
                }
            }

            is BulkGradeMachine.Phase.Failed -> Column(
                verticalArrangement = Arrangement.spacedBy(Spacing.xs),
            ) {
                Text(phase.message, style = MaterialTheme.typography.bodyMedium)
                BrandSecondaryButton(
                    text = stringResource(R.string.bulkgrade_try_again),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    viewModel.load()
                }
                BrandPrimaryButton(
                    text = stringResource(R.string.bulkgrade_close),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    onClose()
                }
            }
        }
    }

    state.pendingConfirmTier?.let { tier ->
        AlertDialog(
            onDismissRequest = viewModel::cancelTierConfirm,
            title = {
                Text(
                    pluralStringResource(
                        R.plurals.bulkgrade_confirm_title,
                        state.ready.size,
                        state.ready.size,
                    ),
                )
            },
            text = {
                Text(
                    pluralStringResource(
                        R.plurals.bulkgrade_confirm_body,
                        tier.creditCost,
                        tier.label,
                        tier.creditCost,
                        state.creditBalance,
                    ),
                )
            },
            confirmButton = {
                TextButton(onClick = viewModel::confirmTier) { Text(stringResource(R.string.bulkgrade_use_credits)) }
            },
            dismissButton = {
                TextButton(onClick = viewModel::cancelTierConfirm) { Text(stringResource(R.string.bulkgrade_cancel)) }
            },
        )
    }
}

@Composable
private fun ReadyBody(state: BulkGradeViewModel.State, viewModel: BulkGradeViewModel) {
    val notReady = stringResource(R.string.bulkgrade_not_ready)
    Text(
        stringResource(
            R.string.bulkgrade_counts,
            state.ready.size,
            state.blocked.size,
            state.creditBalance,
        ),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )

    if (state.blocked.isNotEmpty()) {
        Column(
            Modifier
                .fillMaxWidth()
                .background(
                    MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.4f),
                    RoundedCornerShape(12.dp),
                )
                .padding(Spacing.sm),
        ) {
            Text(
                stringResource(R.string.bulkgrade_blocked_count, state.blocked.size),
                style = MaterialTheme.typography.labelLarge,
            )
            // Named individually: "3 blocked" with no names means opening each
            // of twenty items to find which three.
            state.blocked.take(5).forEach { item ->
                Text(
                    stringResource(
                        R.string.bulkgrade_blocked_row,
                        item.title ?: item.inventoryItemId,
                        item.blockers.firstOrNull() ?: notReady,
                    ),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            if (state.blocked.size > 5) {
                Text(
                    stringResource(R.string.bulkgrade_and_more, state.blocked.size - 5),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }

    HorizontalDivider()

    GradeTier.entries.forEach { tier ->
        val selected = tier == state.tier
        Column(
            Modifier
                .fillMaxWidth()
                .border(
                    width = if (selected) 2.dp else 1.dp,
                    color = if (selected) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.outlineVariant
                    },
                    shape = RoundedCornerShape(12.dp),
                )
                .clickable { viewModel.selectTier(tier) }
                .padding(Spacing.sm),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    tier.label,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    pluralStringResource(
                        R.plurals.bulkgrade_tier_cost,
                        tier.creditCost * state.ready.size,
                        tier.creditCost * state.ready.size,
                    ),
                    style = MaterialTheme.typography.labelLarge,
                )
            }
            Text(
                stringResource(R.string.graderequest_tier_detail, tier.turnaround, tier.blurb),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }

    if (state.isBlockedOnCredits) {
        CreditPackSheet(
            // The balance is per ACCOUNT, so any selected item validates it —
            // this one is simply the first ready id.
            itemId = state.ready.firstOrNull()?.inventoryItemId.orEmpty(),
            tier = state.tier,
            creditsRequired = state.validation?.creditsRequired ?: 0,
            creditBalance = state.creditBalance,
            onGranted = { viewModel.revalidate() },
            surface = TopUpSurface.BULK,
        )
    } else {
        BrandPrimaryButton(
            text = pluralStringResource(R.plurals.bulkgrade_title, state.ready.size, state.ready.size),
            enabled = state.canSubmit,
            modifier = Modifier.fillMaxWidth(),
        ) { viewModel.submit() }
    }
}
