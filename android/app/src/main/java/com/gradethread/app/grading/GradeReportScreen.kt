package com.gradethread.app.grading

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.ui.components.ErrorStateView
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import java.util.Locale

/**
 * US-1337: the certified grade report (iOS `GradeReportView`) — score, weighted
 * factor bars, detected defects, condition summary, confidence, and the
 * certificate share behind an integrity check.
 */
@Composable
fun GradeReportScreen(
    itemId: String,
    onClose: () -> Unit,
    /** US-1340: file a dispute against this report. */
    onDispute: (String) -> Unit = {},
    modifier: Modifier = Modifier,
    viewModel: GradeReportViewModel = hiltViewModel(),
) {
    LaunchedEffect(itemId) { viewModel.bind(itemId) }
    val state by viewModel.state.collectAsState()
    GradeReportContent(
        state = state,
        onClose = onClose,
        onDispute = onDispute,
        onRetryLoad = viewModel::load,
        onRetryVerify = viewModel::verify,
        modifier = modifier,
    )
}

/**
 * US-2902 AC3: the screen with no ViewModel in it.
 *
 * WHY THE SPLIT. Everything above this line is wiring: bind the id, collect the
 * flow, hand the callbacks down. Everything below is what a seller actually sees,
 * and it now takes a plain [GradeReportViewModel.State] and four lambdas. That
 * makes it renderable from a screenshot test without standing up a Hilt graph,
 * which is what AC3 needs and what almost every screen in this app currently
 * makes impossible.
 *
 * It also retires the detekt ViewModelForwarding finding on this file by
 * construction rather than by suppression. The child no longer receives a
 * ViewModel because there is no longer one to receive.
 *
 * Internal rather than private: the screenshot test lives in the same module and
 * needs to call it. Not public, because nothing outside the module should.
 */
@Composable
internal fun GradeReportContent(
    state: GradeReportViewModel.State,
    onClose: () -> Unit,
    onDispute: (String) -> Unit,
    onRetryLoad: () -> Unit,
    onRetryVerify: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        // Read here: the share Intent is built inside a click lambda, which is
        // not a composable scope.
        val shareSubject = stringResource(R.string.gradereport_share_subject)
        val shareChooserTitle = stringResource(R.string.gradereport_share_chooser)
        val loaded = state.loaded
        when {
            state.loading -> Box(
                Modifier.fillMaxWidth().padding(Spacing.xl),
                contentAlignment = Alignment.Center,
            ) { CircularProgressIndicator() }

            state.errorMessage != null -> ErrorStateView(
                title = stringResource(R.string.gradereport_couldn_t_load_this_report),
                message = state.errorMessage.orEmpty(),
                retry = onRetryLoad,
            )

            loaded == null -> Column {
                Text(stringResource(R.string.gradereport_no_grade_yet), style = MaterialTheme.typography.titleMedium)
                Text(
                    stringResource(R.string.gradereport_not_graded),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                BrandPrimaryButton(
                    text = stringResource(R.string.gradereport_done),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    onClose()
                }
            }

            else -> {
                Header(loaded)
                FactorBreakdown(loaded.report)
                if (loaded.defects.isNotEmpty()) DefectsCard(loaded.defects)
                SummaryCard(loaded.report)
                ConfidenceCard(loaded.report)

                if (state.isPendingReview) {
                    PendingReviewNotice()
                } else {
                    IntegrityBadge(
                        verification = state.verification,
                        onRetry = onRetryVerify,
                    )
                    if (state.canShare) {
                        val url = loaded.certificateUrl.orEmpty()
                        BrandPrimaryButton(
                            text = stringResource(R.string.gradereport_share_certificate),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            context.startActivity(
                                Intent.createChooser(
                                    Intent(Intent.ACTION_SEND).apply {
                                        type = "text/plain"
                                        putExtra(Intent.EXTRA_TEXT, url)
                                        putExtra(
                                            Intent.EXTRA_SUBJECT,
                                            shareSubject.format(
                                                score(loaded.report.overallScore),
                                                loaded.report.gradeTier,
                                            ),
                                        )
                                    },
                                    shareChooserTitle,
                                ),
                            )
                        }
                    }
                }

                // US-1340: the dispute action, shown only while the window is
                // open. Hidden rather than disabled once it closes — a greyed
                // button with no explanation reads as a bug, and the honest
                // message is simply that the window has passed.
                if (GradeDisputeWindow.isOpen(loaded.report.createdAt)) {
                    val left = GradeDisputeWindow.daysRemaining(loaded.report.createdAt)
                    BrandSecondaryButton(
                        text = if (left != null) {
                            pluralStringResource(R.plurals.gradereport_dispute_days, left, left)
                        } else {
                            stringResource(R.string.gradereport_dispute)
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { onDispute(loaded.report.id) }
                }

                Text(
                    stringResource(R.string.gradereport_disclaimer),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                BrandSecondaryButton(
                    text = stringResource(R.string.gradereport_done),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    onClose()
                }
            }
        }
    }
}

@Composable
private fun Header(loaded: LoadedGradeReport) {
    // Resolved out here: `semantics { }` is not a composable scope, so a
    // stringResource call inside it does not compile.
    val spoken = stringResource(
        R.string.gradereport_overall_spoken,
        score(loaded.report.overallScore),
        loaded.report.gradeTier,
    )
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(
            score(loaded.report.overallScore),
            style = MaterialTheme.typography.displayMedium,
            color = gradeColor(loaded.report.overallScore),
            modifier = Modifier
                .padding(end = Spacing.sm)
                .semantics { contentDescription = spoken },
        )
        Column(Modifier.weight(1f)) {
            loaded.itemTitle?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.titleMedium)
            }
            Text(
                loaded.report.gradeTier,
                style = MaterialTheme.typography.titleSmall,
                color = gradeColor(loaded.report.overallScore),
            )
        }
    }
}

@Composable
private fun FactorBreakdown(report: GradeReportDto) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
        HorizontalDivider()
        Text(
            stringResource(R.string.gradereport_condition_factors),
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
        )
        GradeFactor.entries.forEach { factor ->
            val value = factor.score(report)
            // See Header: `semantics { }` is not a composable scope.
            val spoken = stringResource(
                R.string.gradereport_factor_spoken,
                factor.label,
                factor.weightLabel,
                score(value),
            )
            Column(
                Modifier.fillMaxWidth().semantics { contentDescription = spoken },
            ) {
                Row(Modifier.fillMaxWidth()) {
                    Text(
                        stringResource(R.string.gradereport_factor_label, factor.label, factor.weightLabel),
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.weight(1f),
                    )
                    Text(score(value), style = MaterialTheme.typography.labelMedium)
                }
                FactorBar(value)
            }
        }
    }
}

@Composable
private fun FactorBar(value: Double) {
    val fraction = (value / 10.0).coerceIn(0.0, 1.0).toFloat()
    Box(
        Modifier
            .fillMaxWidth()
            .height(6.dp)
            .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(3.dp)),
    ) {
        Box(
            Modifier
                .fillMaxWidth(fraction)
                .height(6.dp)
                .background(gradeColor(value), RoundedCornerShape(3.dp)),
        )
    }
}

@Composable
private fun DefectsCard(defects: List<GradeDefect>) {
    // buildString's lambda is not a composable scope.
    val separator = stringResource(R.string.gradereport_defect_separator)
    Column(
        Modifier
            .fillMaxWidth()
            .background(
                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                RoundedCornerShape(12.dp),
            )
            .padding(Spacing.sm),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Text(stringResource(R.string.gradereport_detected_issues), style = MaterialTheme.typography.labelLarge)
        defects.forEach { defect ->
            Text(
                buildString {
                    append(defect.defect)
                    defect.location?.takeIf { it.isNotBlank() }?.let { append(separator.format(it)) }
                    append(separator.format(defect.severity))
                },
                style = MaterialTheme.typography.bodySmall,
            )
            defect.impactOnGrade?.takeIf { it.isNotBlank() }?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun SummaryCard(report: GradeReportDto) {
    if (report.aiSummary.isBlank()) return
    Column(Modifier.fillMaxWidth()) {
        Text(stringResource(R.string.gradereport_condition_summary), style = MaterialTheme.typography.labelLarge)
        Text(report.aiSummary, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun ConfidenceCard(report: GradeReportDto) {
    val percent = Math.round(report.confidenceScore.coerceIn(0.0, 1.0) * 100)
    Text(
        stringResource(
            R.string.gradereport_confidence,
            GradeScale.confidenceLabel(report.confidenceScore),
            percent,
        ),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun PendingReviewNotice() {
    Column(
        Modifier
            .fillMaxWidth()
            .background(
                MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.5f),
                RoundedCornerShape(12.dp),
            )
            .padding(Spacing.sm),
    ) {
        Text(stringResource(R.string.gradereport_pending_human_review), style = MaterialTheme.typography.labelLarge)
        Text(
            stringResource(R.string.gradereport_below_threshold),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun IntegrityBadge(verification: CertVerification, onRetry: () -> Unit) {
    val display = CertIntegrity.display(verification)
    Column(
        Modifier
            .fillMaxWidth()
            .background(toneColor(display.tone).copy(alpha = 0.10f), RoundedCornerShape(12.dp))
            .padding(Spacing.sm),
        verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
    ) {
        Text(display.title, style = MaterialTheme.typography.labelLarge, color = toneColor(display.tone))
        Text(
            display.detail,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (display.retryable) {
            BrandSecondaryButton(
                text = stringResource(R.string.gradereport_try_again),
                modifier = Modifier.fillMaxWidth(),
            ) {
                onRetry()
            }
        }
    }
}

@Composable
private fun toneColor(tone: CertIntegrity.Tone): Color = when (tone) {
    CertIntegrity.Tone.VERIFIED -> Color(0xFF10B981)
    CertIntegrity.Tone.DANGER -> MaterialTheme.colorScheme.error
    CertIntegrity.Tone.WARNING -> Color(0xFFF59E0B)
    CertIntegrity.Tone.NEUTRAL -> MaterialTheme.colorScheme.onSurfaceVariant
}

private fun score(value: Double): String = String.format(Locale.US, "%.1f", value)

/** The four GradeScale tiers (same mapping as the inventory row's chip). */
private fun gradeColor(value: Double): Color = when {
    value >= 9.5 -> Color(0xFF10B981)
    value >= 7.0 -> Color(0xFF0F3460)
    value >= 5.0 -> Color(0xFFF59E0B)
    else -> Color(0xFFE94560)
}
