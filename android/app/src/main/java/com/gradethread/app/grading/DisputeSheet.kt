package com.gradethread.app.grading

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1340: dispute a certified grade (iOS `DisputeSheet`).
 */
@Composable
fun DisputeSheet(
    gradeReportId: String,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
    viewModel: DisputeViewModel = hiltViewModel(),
) {
    LaunchedEffect(gradeReportId) { viewModel.bind(gradeReportId) }
    val state by viewModel.state.collectAsState()

    Column(
        modifier = modifier.fillMaxWidth().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Text("Dispute this grade", style = MaterialTheme.typography.titleLarge)

        val filed = state.filed
        val existing = state.existing
        when {
            filed != null -> Outcome(
                title = "Dispute filed",
                body = "A grader will review this and you'll see the outcome on the item. " +
                    "You don't need to do anything else.",
                extra = state.evidenceFailures.takeIf { it > 0 }?.let {
                    // Never swallowed: the seller chose those photos as their
                    // evidence and is entitled to know they didn't make it.
                    "$it evidence photo${if (it == 1) "" else "s"} couldn't be attached."
                },
                onClose = onClose,
            )

            existing != null -> Outcome(
                title = DisputeStatusDisplay.label(existing.status) ?: "Already disputed",
                body = "You've already disputed this grade — a second one would just " +
                    "duplicate it in the review queue. The outcome appears on the item.",
                extra = existing.reason.takeIf { it.isNotBlank() },
                onClose = onClose,
            )

            else -> {
                Text(
                    "Tell us what's wrong and a grader will take another look.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                DisputeReason.entries.forEach { reason ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable { viewModel.setReason(reason) }
                            .semantics { contentDescription = reason.label },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(
                            selected = reason == state.reason,
                            onClick = { viewModel.setReason(reason) },
                        )
                        Text(reason.label, style = MaterialTheme.typography.bodyMedium)
                    }
                }

                OutlinedTextField(
                    value = state.details,
                    onValueChange = viewModel::setDetails,
                    label = {
                        Text(
                            if (state.needsDetails) {
                                "What happened? (required)"
                            } else {
                                "Anything to add? (optional)"
                            },
                        )
                    },
                    minLines = 3,
                    isError = state.needsDetails && !state.canSubmit && state.details.isNotEmpty(),
                    modifier = Modifier.fillMaxWidth(),
                )

                if (state.needsDetails) {
                    // Say the actual requirement rather than greying the button
                    // out and leaving the seller to guess what it wants.
                    val remaining =
                        DisputeComposer.OTHER_MIN_LENGTH - state.details.trim().length
                    Text(
                        if (remaining > 0) {
                            "$remaining more characters needed."
                        } else {
                            "Thanks — that's enough to work with."
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                state.errorMessage?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }

                BrandPrimaryButton(
                    text = if (state.submitting) "Filing…" else "File dispute",
                    enabled = state.canSubmit,
                    modifier = Modifier.fillMaxWidth(),
                ) { viewModel.submit() }
                BrandSecondaryButton(text = "Cancel", modifier = Modifier.fillMaxWidth()) {
                    onClose()
                }
            }
        }
    }
}

@Composable
private fun Outcome(
    title: String,
    body: String,
    onClose: () -> Unit,
    extra: String? = null,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(
                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                RoundedCornerShape(12.dp),
            )
            .padding(Spacing.sm),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(
            body,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        extra?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        BrandPrimaryButton(text = "Done", modifier = Modifier.fillMaxWidth()) { onClose() }
    }
}
