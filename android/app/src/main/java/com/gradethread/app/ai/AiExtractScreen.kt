package com.gradethread.app.ai

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.ui.components.ErrorStateView
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1334: the post-capture AI step (iOS `AIExtractView`).
 *
 * A thin OBSERVER of [AiExtractionManager] — it starts nothing and owns no
 * run. That's what makes "keep it running in the background" honest: leaving
 * this screen drops a subscriber, not the work.
 *
 * @param onDone the review was applied, skipped, or backgrounded — land the
 *   seller on the item they just created rather than back in the camera.
 */
@Composable
fun AiExtractScreen(
    itemId: String,
    onDone: () -> Unit,
    modifier: Modifier = Modifier,
    viewModel: AiFillReviewViewModel = hiltViewModel(),
) {
    LaunchedEffect(itemId) { viewModel.bind(itemId) }
    val state by viewModel.state.collectAsState()

    // Applying is terminal for this screen; the item canvas owns the row now.
    LaunchedEffect(state.applied) { if (state.applied) onDone() }

    val review = state.review
    Column(
        modifier = modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        when {
            review != null -> {
                state.errorMessage?.let { message ->
                    Text(message, color = MaterialTheme.colorScheme.error)
                }
                AiFillReviewSheet(
                    review = review,
                    onApply = viewModel::apply,
                    onUndoAll = viewModel::undoAll,
                    // Cancel leaves the review UNCONSUMED (US-1182), so the
                    // item's AI banner can pop the same sheet later.
                    onCancel = {
                        viewModel.dismissWithoutConsuming()
                        onDone()
                    },
                )
                TextButton(onClick = { viewModel.skip(); onDone() }, Modifier.fillMaxWidth()) {
                    Text("Skip these suggestions")
                }
            }

            state.phase is AiExtractPhase.Failed -> ErrorStateView(
                title = "AI couldn't read these photos",
                message = (state.phase as AiExtractPhase.Failed).message,
                // The item and its photos already exist, so "try again" here
                // means re-running extraction — which the item canvas owns.
                // Leaving is the honest primary action.
                retryTitle = "Continue to the item",
                retry = { onDone() },
            )

            else -> Progress(state.phase, onBackground = onDone)
        }
    }
}

@Composable
private fun Progress(phase: AiExtractPhase?, onBackground: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        when (phase) {
            is AiExtractPhase.Uploading -> {
                Text("Saving your photos…", style = MaterialTheme.typography.titleMedium)
                Text(
                    "${phase.done} of ${phase.total} uploaded",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                LinearProgressIndicator(
                    progress = {
                        if (phase.total == 0) 0f else phase.done.toFloat() / phase.total
                    },
                    modifier = Modifier.fillMaxWidth().padding(vertical = Spacing.sm),
                )
            }

            else -> {
                CircularProgressIndicator()
                Text(
                    "Reading your photos…",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(top = Spacing.sm),
                )
                Text(
                    "This takes up to a minute.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        // The run lives in the manager, so leaving genuinely doesn't stop it.
        TextButton(onClick = onBackground, modifier = Modifier.padding(top = Spacing.md)) {
            Text("Finish in the background")
        }
    }
}
