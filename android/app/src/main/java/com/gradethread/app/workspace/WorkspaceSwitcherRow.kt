package com.gradethread.app.workspace

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1388: which workspace you are in, and how to leave it.
 *
 * Shown even when there is only one workspace. "Whose inventory am I looking
 * at" is the question this control answers, and a control that disappears when
 * the answer is "yours" makes the answer ambiguous exactly when a member has
 * just switched back.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceSwitcherRow(viewModel: WorkspaceViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()

    Column(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = state.hasChoice && !state.switching) { viewModel.openPicker() }
            .padding(horizontal = Spacing.md, vertical = Spacing.xs)
            .semantics {
                contentDescription = buildString {
                    append("Workspace: ")
                    append(state.active?.name ?: "loading")
                    if (state.hasChoice) append(". Tap to switch.")
                }
            },
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                state.active?.name ?: Workspaces.PERSONAL_NAME,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            if (state.switching) {
                // Named, not a bare spinner: the app is about to empty and
                // refill every screen, and silence there looks like a crash.
                Text("Switching…", style = MaterialTheme.typography.labelMedium)
            } else if (state.hasChoice) {
                Text("Switch", style = MaterialTheme.typography.labelMedium)
            }
        }
        Text(
            state.subtitle,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }

    if (state.pickerOpen) {
        ModalBottomSheet(onDismissRequest = viewModel::closePicker) {
            Column(Modifier.fillMaxWidth().padding(bottom = Spacing.xl)) {
                Text(
                    "Switch workspace",
                    style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.padding(horizontal = Spacing.md),
                )
                Text(
                    // Said before, not after: the switch clears the local copy
                    // and re-downloads, which on a slow connection is a long
                    // silence to explain afterwards.
                    "This reloads your inventory, sales and listings for the " +
                        "workspace you pick.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = Spacing.md, vertical = Spacing.xs),
                )
                state.workspaces.forEach { workspace ->
                    val selected = workspace.ownerId == (state.active?.ownerId)
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clickable { viewModel.switchTo(workspace) }
                            .padding(horizontal = Spacing.md, vertical = Spacing.sm)
                            .semantics {
                                contentDescription = "${workspace.name}" +
                                    if (selected) ", current workspace" else ""
                            },
                    ) {
                        Text(
                            if (selected) "✓ ${workspace.name}" else workspace.name,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Text(
                            if (workspace.isPersonal) {
                                "Your own inventory and sales"
                            } else {
                                "Shared workspace"
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }

    state.notice?.let { notice ->
        AlertDialog(
            onDismissRequest = viewModel::dismissNotice,
            title = { Text("Workspace access changed") },
            text = { Text(notice) },
            confirmButton = {
                TextButton(onClick = viewModel::dismissNotice) { Text("OK") }
            },
        )
    }
}
