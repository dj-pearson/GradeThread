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
    val context = LocalContext.current

    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        val loaded = state.loaded
        when {
            state.loading -> Box(
                Modifier.fillMaxWidth().padding(Spacing.xl),
                contentAlignment = Alignment.Center,
            ) { CircularProgressIndicator() }

            state.errorMessage != null -> ErrorStateView(
                title = "Couldn't load this report",
                message = state.errorMessage.orEmpty(),
                retry = { viewModel.load() },
            )

            loaded == null -> Column {
                Text("No grade yet", style = MaterialTheme.typography.titleMedium)
                Text(
                    "This item hasn't been graded. Request a certified grade from the " +
                        "item's Grade action.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                BrandPrimaryButton(text = "Done", modifier = Modifier.fillMaxWidth()) { onClose() }
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
                        onRetry = viewModel::verify,
                    )
                    if (state.canShare) {
                        val url = loaded.certificateUrl.orEmpty()
                        BrandPrimaryButton(
                            text = "Share certificate",
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            context.startActivity(
                                Intent.createChooser(
                                    Intent(Intent.ACTION_SEND).apply {
                                        type = "text/plain"
                                        putExtra(Intent.EXTRA_TEXT, url)
                                        putExtra(
                                            Intent.EXTRA_SUBJECT,
                                            "GradeThread certificate — " +
                                                score(loaded.report.overallScore) + " " +
                                                loaded.report.gradeTier,
                                        )
                                    },
                                    "Share certificate",
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
                            "Dispute this grade ($left day${if (left == 1) "" else "s"} left)"
                        } else {
                            "Dispute this grade"
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { onDispute(loaded.report.id) }
                }

                Text(
                    "AI-assisted condition assessment. Grades reflect the photos supplied " +
                        "and are not an authentication or appraisal.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                BrandSecondaryButton(text = "Done", modifier = Modifier.fillMaxWidth()) { onClose() }
            }
        }
    }
}

@Composable
private fun Header(loaded: LoadedGradeReport) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(
            score(loaded.report.overallScore),
            style = MaterialTheme.typography.displayMedium,
            color = gradeColor(loaded.report.overallScore),
            modifier = Modifier
                .padding(end = Spacing.sm)
                .semantics {
                    contentDescription = "Overall grade ${score(loaded.report.overallScore)} " +
                        "out of 10, ${loaded.report.gradeTier}"
                },
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
            "Condition factors",
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
        )
        GradeFactor.entries.forEach { factor ->
            val value = factor.score(report)
            Column(
                Modifier.fillMaxWidth().semantics {
                    contentDescription = "${factor.label}, weighted ${factor.weightLabel}: " +
                        "${score(value)} out of 10"
                },
            ) {
                Row(Modifier.fillMaxWidth()) {
                    Text(
                        "${factor.label} (${factor.weightLabel})",
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
        Text("Detected issues", style = MaterialTheme.typography.labelLarge)
        defects.forEach { defect ->
            Text(
                buildString {
                    append(defect.defect)
                    defect.location?.takeIf { it.isNotBlank() }?.let { append(" · $it") }
                    append(" · ${defect.severity}")
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
        Text("Condition summary", style = MaterialTheme.typography.labelLarge)
        Text(report.aiSummary, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun ConfidenceCard(report: GradeReportDto) {
    val percent = Math.round(report.confidenceScore.coerceIn(0.0, 1.0) * 100)
    Text(
        "Confidence: ${GradeScale.confidenceLabel(report.confidenceScore)} ($percent%)",
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
        Text("Pending human review", style = MaterialTheme.typography.labelLarge)
        Text(
            "This grade's confidence is below our certify threshold, so a reviewer is " +
                "taking a look. You'll be able to share a public certificate once it clears.",
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
            BrandSecondaryButton(text = "Try again", modifier = Modifier.fillMaxWidth()) { onRetry() }
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
