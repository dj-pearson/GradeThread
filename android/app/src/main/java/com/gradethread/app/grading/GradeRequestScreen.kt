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
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.R
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.gradeColor
import java.util.Locale

/**
 * US-1336: the certified-grade request surface (iOS `GradeRequestSheet`).
 *
 * US-1338 filled the credit seam: the paywall now renders INSIDE this screen
 * rather than sending the seller elsewhere to buy and find their way back.
 */
@Composable
fun GradeRequestScreen(
    itemId: String,
    onClose: () -> Unit,
    /** US-1337: the full report, with factor bars and the certificate share. */
    onViewReport: () -> Unit,
    modifier: Modifier = Modifier,
    viewModel: GradeRequestViewModel = hiltViewModel(),
) {
    LaunchedEffect(itemId) { viewModel.bind(itemId) }

    // US-1229: leaving stops the poll. The grade still lands server-side and
    // arrives with the next sync — the only thing cancelled is us asking.
    DisposableEffect(Unit) { onDispose { viewModel.stop() } }

    val state by viewModel.state.collectAsState()

    GradeRequestContent(
        state,
        GradeRequestActions(
            selectTier = viewModel::selectTier,
            confirmTier = viewModel::confirmTier,
            cancelTierConfirm = viewModel::cancelTierConfirm,
            submit = viewModel::submit,
            retry = viewModel::load,
            revalidate = viewModel::revalidate,
            close = onClose,
            viewReport = onViewReport,
        ),
        modifier = modifier,
    )
}

/** Everything this screen can be asked to do (US-2902 AC3). */
@Immutable
data class GradeRequestActions(
    val selectTier: (GradeTier) -> Unit = {},
    val confirmTier: () -> Unit = {},
    val cancelTierConfirm: () -> Unit = {},
    val submit: () -> Unit = {},
    val retry: () -> Unit = {},
    val revalidate: suspend () -> Unit = {},
    val close: () -> Unit = {},
    val viewReport: () -> Unit = {},
)

/**
 * Requesting one grade, with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ NINE PHASES, AND FOUR OF THEM ARE "IT DID NOT COME BACK". Completed,
 * PendingReview, StillProcessing, NeedsPhotos and Failed all leave the seller
 * on a screen with a sentence on it, and the differences are entirely in the
 * words and the buttons:
 *
 *   PendingReview    graded, but a human is checking it - NOT a failure
 *   StillProcessing  we stopped waiting; the grade is still coming
 *   NeedsPhotos      we cannot start; the seller has something to fix
 *   Failed           it broke, and retrying is worth a try
 *
 * Telling a seller "couldn't grade this" when the truth is "a human is looking
 * at it" is a support ticket and a refund request. Only a capture sees which
 * words and which buttons came out.
 *
 * ⚠ AND THE SPEND CONFIRMATION IS SKIPPED WHEN NOTHING IS SPENT. The first
 * Standard grade of the month may be included, and a confirmation dialog for a
 * free action trains people to tap through the one that costs money.
 */
@Composable
fun GradeRequestContent(
    state: GradeRequestViewModel.State,
    actions: GradeRequestActions,
    modifier: Modifier = Modifier,
    creditPackSheet: @Composable (GradeRequestViewModel.State) -> Unit = { s ->
        com.gradethread.app.billing.CreditPackSheet(
            itemId = s.itemId.orEmpty(),
            tier = s.tier,
            creditsRequired = s.validation?.creditsRequired ?: 0,
            creditBalance = s.creditBalance,
            onGranted = actions.revalidate,
        )
    },
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Text(stringResource(R.string.graderequest_get_certified_grade), style = MaterialTheme.typography.titleLarge)

        when (val phase = state.phase) {
            GradeRequestMachine.Phase.Loading -> Centered { CircularProgressIndicator() }

            GradeRequestMachine.Phase.Ready -> ReadyBody(state, actions, creditPackSheet)

            GradeRequestMachine.Phase.Submitting,
            GradeRequestMachine.Phase.Processing,
            -> Centered {
                CircularProgressIndicator()
                Text(
                    if (phase == GradeRequestMachine.Phase.Submitting) {
                        stringResource(R.string.graderequest_sending)
                    } else {
                        stringResource(R.string.graderequest_in_progress)
                    },
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(
                    stringResource(R.string.graderequest_can_leave_this_screen_grade),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            is GradeRequestMachine.Phase.Completed -> CompletedBody(phase, actions.close, actions.viewReport)

            is GradeRequestMachine.Phase.PendingReview -> Outcome(
                title = stringResource(R.string.graderequest_submitted_human_review),
                body = stringResource(R.string.graderequest_human_review_body),
                detail = phase.report?.let {
                    stringResource(R.string.graderequest_provisional, score(it.overallScore))
                },
                onClose = actions.close,
            )

            GradeRequestMachine.Phase.StillProcessing -> Outcome(
                title = stringResource(R.string.graderequest_still_grading),
                body = stringResource(R.string.graderequest_slow_body),
                onClose = actions.close,
            )

            is GradeRequestMachine.Phase.NeedsPhotos -> Outcome(
                title = stringResource(R.string.graderequest_needs_clearer_photos),
                body = phase.message,
                // Named explicitly: the single most common worry at this point
                // is "did that cost me a grade?"
                detail = stringResource(R.string.graderequest_not_charged),
                onClose = actions.close,
            )

            is GradeRequestMachine.Phase.Failed -> Outcome(
                title = stringResource(R.string.graderequest_couldn_t_grade_this_item),
                body = phase.message,
                onClose = actions.close,
                onRetry = actions.retry,
            )
        }
    }

    state.pendingConfirmTier?.let { tier ->
        SpendConfirmDialog(
            tier = tier,
            balance = state.creditBalance,
            onConfirm = actions.confirmTier,
            onDismiss = actions.cancelTierConfirm,
        )
    }
}

@Composable
private fun ReadyBody(
    state: GradeRequestViewModel.State,
    actions: GradeRequestActions,
    creditPackSheet: @Composable (GradeRequestViewModel.State) -> Unit,
) {
    val item = state.validation?.item

    item?.title?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }

    Text(
        stringResource(
            R.string.graderequest_balance,
            state.creditBalance,
            state.validation?.user?.includedRemaining ?: 0,
        ),
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
            Text(stringResource(R.string.graderequest_not_ready_grade_yet), style = MaterialTheme.typography.labelLarge)
            state.blockers.forEach { blocker ->
                Text(
                    stringResource(R.string.graderequest_bullet, blocker),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }

    HorizontalDivider()

    GradeTier.entries.forEach { tier ->
        TierRow(
            tier = tier,
            selected = tier == state.tier,
            spendsCredits = state.spendsCredits(tier),
            onClick = { actions.selectTier(tier) },
        )
    }

    if (state.isBlockedOnCredits) {
        // US-1338: buy in place, then re-validate - the server decides whether
        // submit unblocks, not the client's arithmetic on the new balance.
        //
        // A SLOT because CreditPackSheet resolves its own ViewModel through
        // Hilt, and RoborazziActivity is not a Hilt component.
        creditPackSheet(state)
    } else {
        BrandPrimaryButton(
            text = stringResource(R.string.graderequest_grade_this_item),
            enabled = state.canSubmit,
            modifier = Modifier.fillMaxWidth(),
        ) { actions.submit() }
    }
}

@Composable
private fun TierRow(tier: GradeTier, selected: Boolean, spendsCredits: Boolean, onClick: () -> Unit) {
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
                    pluralStringResource(
                        R.plurals.graderequest_credit_cost,
                        tier.creditCost,
                        tier.creditCost,
                    )
                } else {
                    stringResource(R.string.graderequest_included)
                },
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

@Composable
private fun SpendConfirmDialog(tier: GradeTier, balance: Int, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                pluralStringResource(
                    R.plurals.graderequest_spend_title,
                    tier.creditCost,
                    tier.creditCost,
                ),
            )
        },
        text = {
            Text(
                pluralStringResource(
                    R.plurals.graderequest_spend_body,
                    tier.creditCost,
                    tier.label,
                    tier.creditCost,
                    balance,
                ),
            )
        },
        confirmButton = { TextButton(onClick = onConfirm) { Text(stringResource(R.string.graderequest_use_credits)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.graderequest_cancel)) } },
    )
}

@Composable
private fun CompletedBody(phase: GradeRequestMachine.Phase.Completed, onClose: () -> Unit, onViewReport: () -> Unit) {
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
        BrandPrimaryButton(
            text = stringResource(R.string.graderequest_view_full_report),
            modifier = Modifier.fillMaxWidth(),
        ) {
            onViewReport()
        }
        BrandSecondaryButton(text = stringResource(R.string.graderequest_done), modifier = Modifier.fillMaxWidth()) {
            onClose()
        }
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
            BrandSecondaryButton(
                text = stringResource(R.string.graderequest_try_again),
                modifier = Modifier.fillMaxWidth(),
            ) {
                it()
            }
        }
        BrandPrimaryButton(text = stringResource(R.string.graderequest_done), modifier = Modifier.fillMaxWidth()) {
            onClose()
        }
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
