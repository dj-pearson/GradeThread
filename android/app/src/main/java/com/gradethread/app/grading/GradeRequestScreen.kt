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
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import java.util.Locale

/**
 * US-1336: the certified-grade request surface (iOS `GradeRequestSheet`).
 *
 * @param onTopUpCredits blocked on credits — US-1338 (Play Billing) owns the
 *   in-flow purchase; this is the seam it plugs into.
 */
@Composable
fun GradeRequestScreen(
    itemId: String,
    onClose: () -> Unit,
    onTopUpCredits: () -> Unit,
    modifier: Modifier = Modifier,
    viewModel: GradeRequestViewModel = hiltViewModel(),
) {
    LaunchedEffect(itemId) { viewModel.bind(itemId) }

    // US-1229: leaving stops the poll. The grade still lands server-side and
    // arrives with the next sync — the only thing cancelled is us asking.
    DisposableEffect(Unit) { onDispose { viewModel.stop() } }

    val state by viewModel.state.collectAsState()

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Text("Get a certified grade", style = MaterialTheme.typography.titleLarge)

        when (val phase = state.phase) {
            GradeRequestMachine.Phase.Loading -> Centered { CircularProgressIndicator() }

            GradeRequestMachine.Phase.Ready -> ReadyBody(state, viewModel, onTopUpCredits)

            GradeRequestMachine.Phase.Submitting,
            GradeRequestMachine.Phase.Processing,
            -> Centered {
                CircularProgressIndicator()
                Text(
                    if (phase == GradeRequestMachine.Phase.Submitting) {
                        "Sending your item…"
                    } else {
                        "Grading in progress…"
                    },
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(
                    "You can leave this screen — the grade lands on the item either way.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            is GradeRequestMachine.Phase.Completed -> CompletedBody(phase, onClose)

            is GradeRequestMachine.Phase.PendingReview -> Outcome(
                title = "Submitted for human review",
                body = "The AI wasn't confident enough to certify this one on its own, so a " +
                    "grader is checking it. You'll see the final grade on the item when " +
                    "it clears.",
                detail = phase.report?.let { "Provisional score ${score(it.overallScore)}" },
                onClose = onClose,
            )

            GradeRequestMachine.Phase.StillProcessing -> Outcome(
                title = "Still grading",
                body = "This one's taking longer than usual. Nothing is lost — the grade " +
                    "will appear on the item as soon as it's done.",
                onClose = onClose,
            )

            is GradeRequestMachine.Phase.NeedsPhotos -> Outcome(
                title = "Needs clearer photos",
                body = phase.message,
                // Named explicitly: the single most common worry at this point
                // is "did that cost me a grade?"
                detail = "You weren't charged.",
                onClose = onClose,
            )

            is GradeRequestMachine.Phase.Failed -> Outcome(
                title = "Couldn't grade this item",
                body = phase.message,
                onClose = onClose,
                onRetry = viewModel::load,
            )
        }
    }

    state.pendingConfirmTier?.let { tier ->
        SpendConfirmDialog(
            tier = tier,
            balance = state.creditBalance,
            onConfirm = viewModel::confirmTier,
            onDismiss = viewModel::cancelTierConfirm,
        )
    }
}

@Composable
private fun ReadyBody(
    state: GradeRequestViewModel.State,
    viewModel: GradeRequestViewModel,
    onTopUpCredits: () -> Unit,
) {
    val item = state.validation?.item

    item?.title?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }

    Text(
        "${state.creditBalance} credits · ${state.validation?.user?.includedRemaining ?: 0} " +
            "included grades left",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )

    if (state.blockers.isNotEmpty()) {
        Column(
            Modifier
                .fillMaxWidth()
                .background(
                    MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.4f),
                    RoundedCornerShape(12.dp),
                )
                .padding(Spacing.sm),
        ) {
            Text("Not ready to grade yet", style = MaterialTheme.typography.labelLarge)
            state.blockers.forEach { blocker ->
                Text("• $blocker", style = MaterialTheme.typography.bodySmall)
            }
        }
    }

    HorizontalDivider()

    GradeTier.entries.forEach { tier ->
        TierRow(
            tier = tier,
            selected = tier == state.tier,
            spendsCredits = state.spendsCredits(tier),
            onClick = { viewModel.selectTier(tier) },
        )
    }

    if (state.isBlockedOnCredits) {
        Column(
            Modifier
                .fillMaxWidth()
                .background(
                    MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.5f),
                    RoundedCornerShape(12.dp),
                )
                .padding(Spacing.sm),
            verticalArrangement = Arrangement.spacedBy(Spacing.xs),
        ) {
            Text(
                "This grade needs ${state.validation?.creditsRequired ?: 0} credits and you " +
                    "have ${state.creditBalance}.",
                style = MaterialTheme.typography.bodyMedium,
            )
            BrandPrimaryButton(text = "Add credits", modifier = Modifier.fillMaxWidth()) {
                onTopUpCredits()
            }
        }
    } else {
        BrandPrimaryButton(
            text = "Grade this item",
            enabled = state.canSubmit,
            modifier = Modifier.fillMaxWidth(),
        ) { viewModel.submit() }
    }
}

@Composable
private fun TierRow(
    tier: GradeTier,
    selected: Boolean,
    spendsCredits: Boolean,
    onClick: () -> Unit,
) {
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
            .clickable(onClick = onClick)
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
                if (spendsCredits) {
                    "${tier.creditCost} credit${if (tier.creditCost == 1) "" else "s"}"
                } else {
                    "Included"
                },
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

@Composable
private fun SpendConfirmDialog(
    tier: GradeTier,
    balance: Int,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Use ${tier.creditCost} credits?") },
        text = {
            Text(
                "${tier.label} grading costs ${tier.creditCost} credit" +
                    "${if (tier.creditCost == 1) "" else "s"}. You have $balance. " +
                    "You're only charged when the grade succeeds.",
            )
        },
        confirmButton = { TextButton(onClick = onConfirm) { Text("Use credits") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun CompletedBody(phase: GradeRequestMachine.Phase.Completed, onClose: () -> Unit) {
    val report = phase.report
    Column(
        Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            score(report.overallScore),
            style = MaterialTheme.typography.displayMedium,
            color = gradeColor(report.overallScore),
        )
        Text(report.gradeTier, style = MaterialTheme.typography.titleMedium)
        Text(
            report.aiSummary,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        BrandPrimaryButton(text = "Done", modifier = Modifier.fillMaxWidth()) { onClose() }
    }
}

@Composable
private fun Outcome(
    title: String,
    body: String,
    onClose: () -> Unit,
    detail: String? = null,
    onRetry: (() -> Unit)? = null,
) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(
            body,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        detail?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        onRetry?.let {
            BrandSecondaryButton(text = "Try again", modifier = Modifier.fillMaxWidth()) { it() }
        }
        BrandPrimaryButton(text = "Done", modifier = Modifier.fillMaxWidth()) { onClose() }
    }
}

@Composable
private fun Centered(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxWidth().padding(Spacing.xl), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Spacing.xs),
        ) { content() }
    }
}

private fun score(value: Double): String = String.format(Locale.US, "%.1f", value)

/** The four GradeScale tiers (same mapping as the inventory row's chip). */
private fun gradeColor(value: Double): Color = when {
    value >= 9.5 -> Color(0xFF10B981)
    value >= 7.0 -> Color(0xFF0F3460)
    value >= 5.0 -> Color(0xFFF59E0B)
    else -> Color(0xFFE94560)
}
