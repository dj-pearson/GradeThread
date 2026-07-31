package com.gradethread.app.feedback

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.runtime.LaunchedEffect
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1387: "Send feedback".
 *
 * Hosted where it is opened from (Settings) so its ViewModel — and therefore
 * the draft — outlives the sheet itself. Renders nothing when closed.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun FeedbackSheet(
    onOpenSupport: () -> Unit,
    viewModel: FeedbackViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()
    val view = LocalView.current
    // Resolved OUTSIDE the effect: stringResource is a composable read, and
    // LaunchedEffect's body is not a composable scope.
    val sentAnnouncement = stringResource(R.string.feedback_sent_announcement)

    // Announced, not just shown: the confirmation auto-dismisses after a beat,
    // so a screen-reader user would otherwise never learn it worked.
    LaunchedEffect(state.sent) {
        if (state.sent) view.announceForAccessibility(sentAnnouncement)
    }

    if (!state.open) return

    // skipPartiallyExpanded so a long message isn't typed into a half sheet
    // that the keyboard then covers.
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    // Mid-send, `dismiss` is a no-op, so a swipe or a back press leaves the
    // sheet up rather than hiding a request that is already in flight.
    ModalBottomSheet(
        onDismissRequest = viewModel::dismiss,
        sheetState = sheetState,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Spacing.md)
                .padding(bottom = Spacing.xl),
        ) {
            Text(
                stringResource(R.string.feedback_title),
                style = MaterialTheme.typography.titleLarge,
            )
            Text(
                stringResource(R.string.feedback_context),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = Spacing.xs, bottom = Spacing.sm),
            )

            FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                Feedback.Category.entries.forEach { category ->
                    val selected = state.category == category
                    val chipState = stringResource(
                        R.string.feedback_chip_state,
                        category.label,
                        stringResource(
                            if (selected) {
                                R.string.feedback_chip_selected
                            } else {
                                R.string.feedback_chip_unselected
                            },
                        ),
                    )
                    FilterChip(
                        selected = selected,
                        onClick = { viewModel.setCategory(category) },
                        enabled = !state.sending,
                        label = { Text(category.label) },
                        modifier = Modifier.semantics {
                            contentDescription = chipState
                        },
                    )
                }
            }

            OutlinedTextField(
                value = state.message,
                onValueChange = viewModel::setMessage,
                label = { Text(state.category.hint) },
                minLines = 5,
                enabled = !state.sending,
                isError = state.messageError != null || state.error != null,
                supportingText = {
                    Text(
                        state.error
                            ?: state.messageError
                            ?: "${state.message.length} / ${Feedback.MAX_MESSAGE}",
                    )
                },
                modifier = Modifier.fillMaxWidth().padding(top = Spacing.sm),
            )

            if (state.sent) {
                Text(
                    Feedback.SENT,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(top = Spacing.xs),
                )
            }

            BrandPrimaryButton(
                text = stringResource(
                    if (state.sending) R.string.common_sending else R.string.feedback_title,
                ),
                modifier = Modifier.fillMaxWidth().padding(top = Spacing.md),
                enabled = state.canSend,
            ) { viewModel.send() }

            Text(
                Feedback.ONE_WAY_NOTE,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = Spacing.md),
            )
            BrandSecondaryButton(
                text = stringResource(R.string.feedback_open_support),
                modifier = Modifier.fillMaxWidth().padding(top = Spacing.xs),
                enabled = !state.sending,
            ) {
                viewModel.dismiss()
                onOpenSupport()
            }
        }
    }
}
