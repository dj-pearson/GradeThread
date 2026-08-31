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
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.ui.text
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
    val name = state.active?.name ?: stringResource(R.string.workspace_personal_subtitle)
    val spoken = if (state.hasChoice) {
        stringResource(R.string.workspace_spoken_tappable, name)
    } else {
        stringResource(R.string.workspace_spoken, name)
    }

    Column(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = state.hasChoice && !state.switching) { viewModel.openPicker() }
            .padding(horizontal = Spacing.md, vertical = Spacing.xs)
            .semantics {
                contentDescription = spoken
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
                Text(
                    stringResource(R.string.workspace_switching),
                    style = MaterialTheme.typography.labelMedium,
                )
            } else if (state.hasChoice) {
                Text(
                    stringResource(R.string.workspace_switch),
                    style = MaterialTheme.typography.labelMedium,
                )
            }
        }
        Text(
            state.subtitle.text(),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }

    if (state.pickerOpen) {
        ModalBottomSheet(onDismissRequest = viewModel::closePicker) {
            Column(Modifier.fillMaxWidth().padding(bottom = Spacing.xl)) {
                Text(
                    stringResource(R.string.workspace_picker_title),
                    style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.padding(horizontal = Spacing.md),
                )
                Text(
                    // Said before, not after: the switch clears the local copy
                    // and re-downloads, which on a slow connection is a long
                    // silence to explain afterwards.
                    stringResource(R.string.workspace_picker_warning),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = Spacing.md, vertical = Spacing.xs),
                )
                state.workspaces.forEach { workspace ->
                    val selected = workspace.ownerId == (state.active?.ownerId)
                    val rowSpoken = if (selected) {
                        stringResource(R.string.workspace_row_current, workspace.name)
                    } else {
                        workspace.name
                    }
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clickable { viewModel.switchTo(workspace) }
                            .padding(horizontal = Spacing.md, vertical = Spacing.sm)
                            .semantics { contentDescription = rowSpoken },
                    ) {
                        Text(
                            if (selected) {
                                stringResource(R.string.checked_prefix, workspace.name)
                            } else {
                                workspace.name
                            },
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Text(
                            stringResource(
                                if (workspace.isPersonal) {
                                    R.string.workspace_personal_subtitle
                                } else {
                                    R.string.workspace_shared_subtitle
                                },
                            ),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }

    // US-2685 AC5: the workspace-MFA block opens the enrollment screen itself.
    //
    // NOT a notice with a link. The member is refused on every request until
    // this session reaches aal2, and that is something they can fix right here
    // — a sentence pointing at gradethread.com asks them to go and do on a
    // desktop what the phone in their hand can do now.
    if (state.mfaRequired) {
        com.gradethread.app.settings.TwoFactorDialog(
            onDismiss = viewModel::clearMfaRequired,
        )
    }

    state.notice?.let { notice ->
        AlertDialog(
            onDismissRequest = viewModel::dismissNotice,
            title = { Text(stringResource(R.string.workspace_access_changed)) },
            text = { Text(notice.text()) },
            confirmButton = {
                TextButton(onClick = viewModel::dismissNotice) {
                    Text(stringResource(R.string.common_ok))
                }
            },
        )
    }
}
