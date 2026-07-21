package com.gradethread.app.inventory

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.gradethread.app.ui.theme.Spacing
import kotlinx.coroutines.delay

/**
 * US-1348: the multi-select action bar.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun BulkActionBar(
    selectedCount: Int,
    stage: InventoryStage,
    busy: Boolean,
    onClear: () -> Unit,
    onAction: (BulkAction) -> Unit,
    modifier: Modifier = Modifier,
) {
    var confirming by remember { mutableStateOf<BulkAction?>(null) }

    Column(
        modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f))
            .padding(horizontal = Spacing.sm, vertical = Spacing.xs),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                "$selectedCount selected",
                style = MaterialTheme.typography.labelLarge,
                modifier = Modifier
                    .weight(1f)
                    .semantics { contentDescription = "$selectedCount items selected" },
            )
            TextButton(onClick = onClear, enabled = !busy) { Text("Clear") }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
            // Stage-appropriate: a status action offered against a mixed
            // selection either regresses rows or skips them, and both read as
            // a bug rather than a rule.
            BulkAction.forStage(stage).forEach { action ->
                AssistChip(
                    enabled = !busy,
                    onClick = {
                        if (action.destructive) confirming = action else onAction(action)
                    },
                    label = { Text(action.label) },
                )
            }
        }
    }

    confirming?.let { action ->
        AlertDialog(
            onDismissRequest = { confirming = null },
            title = { Text(action.confirmationTitle(selectedCount)) },
            confirmButton = {
                TextButton(onClick = { confirming = null; onAction(action) }) {
                    Text(action.label)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirming = null }) { Text("Cancel") }
            },
        )
    }
}

/**
 * The undo snackbar.
 *
 * Shows a live countdown and dismisses itself when the window closes, rather
 * than vanishing silently (iOS US-972) — a seller who looks up to find the
 * Undo gone has no way to know whether they missed it or it never appeared.
 */
@Composable
fun BulkUndoBar(
    undo: BulkUndo,
    onUndo: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var remaining by remember(undo) { mutableStateOf(BulkUndo.WINDOW_SECONDS) }

    LaunchedEffect(undo) {
        remaining = BulkUndo.WINDOW_SECONDS
        while (remaining > 0) {
            delay(1_000)
            remaining -= 1
        }
        onDismiss()
    }

    Row(
        modifier
            .fillMaxWidth()
            .padding(Spacing.xs)
            .background(MaterialTheme.colorScheme.inverseSurface, RoundedCornerShape(8.dp))
            .padding(horizontal = Spacing.sm, vertical = Spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            undo.label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.inverseOnSurface,
            modifier = Modifier.weight(1f),
        )
        Text(
            "${remaining}s",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.inverseOnSurface,
            modifier = Modifier.padding(end = Spacing.xs),
        )
        TextButton(onClick = onUndo) { Text("Undo") }
    }
}

/** The result line, with per-item failures listed rather than counted. */
@Composable
fun BulkResultBar(
    result: BulkActionResult,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.sm, vertical = Spacing.xxs),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                result.summary,
                style = MaterialTheme.typography.bodySmall,
                color = if (result.hasFailures) {
                    MaterialTheme.colorScheme.error
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = onDismiss) { Text("Dismiss") }
        }
        // Reasons, not just a count: "3 failed" leaves the seller to work out
        // which three and why.
        result.failures.take(4).forEach { failure ->
            Text(
                "• ${failure.message}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (result.failures.size > 4) {
            Text(
                "…and ${result.failures.size - 4} more",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
