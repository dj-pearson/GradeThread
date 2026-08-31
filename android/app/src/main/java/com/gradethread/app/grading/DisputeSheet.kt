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
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.R
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
        Text(stringResource(R.string.dispute_title), style = MaterialTheme.typography.titleLarge)

        val filed = state.filed
        val existing = state.existing
        when {
            filed != null -> Outcome(
                title = stringResource(R.string.dispute_filed_title),
                body = stringResource(R.string.dispute_filed_body),
                extra = state.evidenceFailures.takeIf { it > 0 }?.let {
                    // Never swallowed: the seller chose those photos as their
                    // evidence and is entitled to know they didn't make it.
                    pluralStringResource(R.plurals.dispute_photos_failed, it, it)
                },
                onClose = onClose,
            )

            existing != null -> Outcome(
                title = stringResource(
                    DisputeStatusDisplay.label(existing.status)
                        ?: R.string.dispute_already_title,
                ),
                body = stringResource(R.string.dispute_already_body),
                extra = existing.reason.takeIf { it.isNotBlank() },
                onClose = onClose,
            )

            else -> {
                Text(
                    stringResource(R.string.dispute_intro),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                DisputeReason.entries.forEach { reason ->
                    // Hoisted: `semantics { }` is not a composable scope, so
                    // stringResource cannot be called inside it.
                    val reasonLabel = stringResource(reason.label)
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable { viewModel.setReason(reason) }
                            .semantics { contentDescription = reasonLabel },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(
                            selected = reason == state.reason,
                            onClick = { viewModel.setReason(reason) },
                        )
                        Text(reasonLabel, style = MaterialTheme.typography.bodyMedium)
                    }
                }

                OutlinedTextField(
                    value = state.details,
                    onValueChange = viewModel::setDetails,
                    label = {
                        Text(
                            if (state.needsDetails) {
                                stringResource(R.string.dispute_what_happened)
                            } else {
                                stringResource(R.string.dispute_anything_to_add)
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
                            pluralStringResource(
                                R.plurals.dispute_more_characters,
                                remaining,
                                remaining,
                            )
                        } else {
                            stringResource(R.string.dispute_enough)
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
                    text = if (state.submitting) {
                        stringResource(R.string.dispute_filing)
                    } else {
                        stringResource(R.string.dispute_file)
                    },
                    enabled = state.canSubmit,
                    modifier = Modifier.fillMaxWidth(),
                ) { viewModel.submit() }
                BrandSecondaryButton(
                    text = stringResource(R.string.common_cancel),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    onClose()
                }
            }
        }
    }
}

@Composable
private fun Outcome(title: String, body: String, onClose: () -> Unit, extra: String? = null) {
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
        BrandPrimaryButton(
            text = stringResource(R.string.common_done),
            modifier = Modifier.fillMaxWidth(),
        ) { onClose() }
    }
}
