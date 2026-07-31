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

    // Announced, not just shown: the confirmation auto-dismisses after a beat,
    // so a screen-reader user would otherwise never learn it worked.
    LaunchedEffect(state.sent) {
        if (state.sent) view.announceForAccessibility("Feedback sent")
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
            Text("Send feedback", style = MaterialTheme.typography.titleLarge)
            Text(
                "Goes straight to the team with your app version, Android version and " +
                    "device model for context.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = Spacing.xs, bottom = Spacing.sm),
            )

            FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                Feedback.Category.entries.forEach { category ->
                    val selected = state.category == category
                    FilterChip(
                        selected = selected,
                        onClick = { viewModel.setCategory(category) },
                        enabled = !state.sending,
                        label = { Text(category.label) },
                        modifier = Modifier.semantics {
                            contentDescription =
                                "${category.label}, ${if (selected) "selected" else "not selected"}"
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
                text = if (state.sending) "Sending…" else "Send feedback",
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
                text = "Open a support request",
                modifier = Modifier.fillMaxWidth().padding(top = Spacing.xs),
                enabled = !state.sending,
            ) {
                viewModel.dismiss()
                onOpenSupport()
            }
        }
    }
}
