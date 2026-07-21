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
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.billing.CreditPackSheet
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
        Text("Grade ${itemIds.size} items", style = MaterialTheme.typography.titleLarge)

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
                    "Grades land on each item as they finish — no need to wait here.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                BrandPrimaryButton(text = "Done", modifier = Modifier.fillMaxWidth()) { onClose() }
            }

            is BulkGradeMachine.Phase.Empty -> Column(
                verticalArrangement = Arrangement.spacedBy(Spacing.xs),
            ) {
                // No "Try again": an empty selection can never validate.
                Text(phase.message, style = MaterialTheme.typography.bodyMedium)
                BrandPrimaryButton(text = "Close", modifier = Modifier.fillMaxWidth()) { onClose() }
            }

            is BulkGradeMachine.Phase.Failed -> Column(
                verticalArrangement = Arrangement.spacedBy(Spacing.xs),
            ) {
                Text(phase.message, style = MaterialTheme.typography.bodyMedium)
                BrandSecondaryButton(text = "Try again", modifier = Modifier.fillMaxWidth()) {
                    viewModel.load()
                }
                BrandPrimaryButton(text = "Close", modifier = Modifier.fillMaxWidth()) { onClose() }
            }
        }
    }

    state.pendingConfirmTier?.let { tier ->
        AlertDialog(
            onDismissRequest = viewModel::cancelTierConfirm,
            title = { Text("Grade ${state.ready.size} items?") },
            text = {
                Text(
                    "${tier.label} grading costs ${tier.creditCost} credit" +
                        "${if (tier.creditCost == 1) "" else "s"} per item. You have " +
                        "${state.creditBalance}. You're only charged for grades that succeed.",
                )
            },
            confirmButton = { TextButton(onClick = viewModel::confirmTier) { Text("Use credits") } },
            dismissButton = {
                TextButton(onClick = viewModel::cancelTierConfirm) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun ReadyBody(state: BulkGradeViewModel.State, viewModel: BulkGradeViewModel) {
    Text(
        "${state.ready.size} ready · ${state.blocked.size} blocked · " +
            "${state.creditBalance} credits",
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
                "${state.blocked.size} won't be submitted",
                style = MaterialTheme.typography.labelLarge,
            )
            // Named individually: "3 blocked" with no names means opening each
            // of twenty items to find which three.
            state.blocked.take(5).forEach { item ->
                Text(
                    "• ${item.title ?: item.inventoryItemId} — " +
                        (item.blockers.firstOrNull() ?: "not ready"),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            if (state.blocked.size > 5) {
                Text(
                    "…and ${state.blocked.size - 5} more",
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
                    "${tier.creditCost * state.ready.size} credits",
                    style = MaterialTheme.typography.labelLarge,
                )
            }
            Text(
                "${tier.turnaround} · ${tier.blurb}",
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
            surface = "bulk",
        )
    } else {
        BrandPrimaryButton(
            text = "Grade ${state.ready.size} items",
            enabled = state.canSubmit,
            modifier = Modifier.fillMaxWidth(),
        ) { viewModel.submit() }
    }
}
