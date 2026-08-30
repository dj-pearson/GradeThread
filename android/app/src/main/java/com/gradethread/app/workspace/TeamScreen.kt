package com.gradethread.app.workspace

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.R
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-2407: the team screen.
 *
 * Below admin this is a directory, not a control panel: the role picker and
 * the remove button are absent rather than disabled, because a disabled button
 * invites a person to keep tapping something that will never work.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TeamScreen(onClose: () -> Unit, viewModel: TeamViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()

    TeamContent(
        state,
        TeamActions(
            openInvite = viewModel::openInvite,
            closeInvite = viewModel::closeInvite,
            setInviteEmail = viewModel::setInviteEmail,
            setInviteRole = viewModel::setInviteRole,
            sendInvite = viewModel::sendInvite,
            changeRole = viewModel::changeRole,
            remove = viewModel::remove,
            resend = viewModel::resend,
            revoke = viewModel::revoke,
            dismissError = viewModel::dismissError,
            dismissAcceptUrl = viewModel::dismissAcceptUrl,
            close = onClose,
        ),
    )
}

/** Everything this screen can be asked to do (US-2902 AC3). */
@Suppress("LongParameterList")
@Immutable
data class TeamActions(
    val openInvite: () -> Unit = {},
    val closeInvite: () -> Unit = {},
    val setInviteEmail: (String) -> Unit = {},
    val setInviteRole: (WorkspaceRole) -> Unit = {},
    val sendInvite: () -> Unit = {},
    val changeRole: (String, WorkspaceRole) -> Unit = { _, _ -> },
    val remove: (String) -> Unit = {},
    val resend: (String) -> Unit = {},
    val revoke: (String) -> Unit = {},
    val dismissError: () -> Unit = {},
    val dismissAcceptUrl: () -> Unit = {},
    val close: () -> Unit = {},
)

/**
 * The workspace team with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ THE READ-ONLY VIEW IS THE ONE THAT MATTERS. A member who cannot manage the
 * team sees the same list with the Invite button, the role menus and the Remove
 * buttons simply absent - not greyed. Everything about permissions on this
 * screen is what is missing from the layout, which is the one thing a unit test
 * on the state cannot see. Both views are captured.
 *
 * ⚠ AND THE ACCEPT LINK IS OFFERED, NOT MENTIONED. When an invitation is
 * created but its email does not send, that URL is the only way the person gets
 * in. A card that stopped rendering would strand them with no error anywhere.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TeamContent(state: TeamViewModel.State, actions: TeamActions, modifier: Modifier = Modifier) {
    Column(
        modifier.fillMaxSize().padding(Spacing.md).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                stringResource(R.string.team_title),
                style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.weight(1f),
            )
            if (state.canManage) {
                BrandPrimaryButton(
                    text = stringResource(R.string.team_invite),
                    onClick = actions.openInvite,
                )
            }
        }

        if (!state.canManage && !state.loading) {
            Text(
                stringResource(R.string.team_read_only),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth().cardStyle(),
            )
        }

        state.errorMessage?.let { message ->
            Column(Modifier.fillMaxWidth().cardStyle()) {
                Text(
                    message,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                )
                TextButton(onClick = actions.dismissError) {
                    Text(stringResource(R.string.common_dismiss))
                }
            }
        }

        // The invite landed but the email did not. The link is then the only
        // way in, so it is offered rather than mentioned.
        state.acceptUrl?.let { url -> AcceptLinkCard(url, actions) }

        if (state.loading && state.members.isEmpty()) {
            Row(
                Modifier.fillMaxWidth().padding(Spacing.xl),
                horizontalArrangement = Arrangement.Center,
            ) { CircularProgressIndicator() }
        }

        for (member in state.members) {
            MemberRow(member, state, actions)
        }

        if (state.showsInvitations && state.invitations.isNotEmpty()) {
            Text(
                stringResource(R.string.team_pending_header),
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(top = Spacing.sm),
            )
            for (invitation in state.invitations) {
                InvitationRow(invitation, state, actions)
            }
        }

        BrandSecondaryButton(
            text = stringResource(R.string.common_back),
            modifier = Modifier.fillMaxWidth().padding(top = Spacing.sm),
        ) { actions.close() }
    }

    if (state.inviteOpen) {
        ModalBottomSheet(onDismissRequest = actions.closeInvite) {
            InviteSheet(state, actions)
        }
    }
}

@Composable
private fun AcceptLinkCard(url: String, actions: TeamActions) {
    val clipboard = LocalClipboardManager.current
    Column(Modifier.fillMaxWidth().cardStyle()) {
        Text(stringResource(R.string.team_email_not_sent), style = MaterialTheme.typography.bodyMedium)
        Text(
            url,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        Row {
            TextButton(onClick = { clipboard.setText(AnnotatedString(url)) }) {
                Text(stringResource(R.string.team_copy_link))
            }
            TextButton(onClick = actions.dismissAcceptUrl) {
                Text(stringResource(R.string.common_dismiss))
            }
        }
    }
}

@Composable
private fun MemberRow(member: TeamMember, state: TeamViewModel.State, actions: TeamActions) {
    var menuOpen by remember(member.memberId) { mutableStateOf(false) }
    val label = member.email ?: member.name ?: stringResource(R.string.team_unnamed_member)

    Column(Modifier.fillMaxWidth().cardStyle()) {
        Text(label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
        Text(
            roleLabel(member.role),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        if (!state.canAct(member)) return@Column

        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(
                onClick = { menuOpen = true },
                enabled = !state.isBusy("role:${member.memberId}") && state.busyKey == null,
            ) {
                Text(stringResource(R.string.team_change_role))
            }
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                for (role in state.assignableRoles) {
                    DropdownMenuItem(
                        text = { Text(roleLabel(role)) },
                        onClick = {
                            menuOpen = false
                            actions.changeRole(member.memberId, role)
                        },
                    )
                }
            }
            // Removing yourself is a different decision from managing someone
            // else, and the edge has its own last-admin guard for it — the row
            // simply does not offer it.
            if (member.memberId != state.selfId) {
                TextButton(
                    onClick = { actions.remove(member.memberId) },
                    enabled = state.busyKey == null,
                ) {
                    Text(stringResource(R.string.team_remove))
                }
            }
        }
    }
}

@Composable
private fun InvitationRow(invitation: WorkspaceInvitationRow, state: TeamViewModel.State, actions: TeamActions) {
    val days = WorkspaceDate.daysUntil(invitation.expiresAt, System.currentTimeMillis())
    Column(Modifier.fillMaxWidth().cardStyle()) {
        Text(invitation.email, style = MaterialTheme.typography.bodyMedium)
        Text(
            if (days == null) {
                roleLabel(WorkspaceRole.from(invitation.role))
            } else {
                pluralStringResource(
                    R.plurals.team_invite_expires,
                    days.toInt(),
                    roleLabel(WorkspaceRole.from(invitation.role)),
                    days.toInt(),
                )
            },
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row {
            TextButton(
                onClick = { actions.resend(invitation.id) },
                enabled = state.busyKey == null,
            ) {
                Text(stringResource(R.string.team_resend))
            }
            TextButton(
                onClick = { actions.revoke(invitation.id) },
                enabled = state.busyKey == null,
            ) {
                Text(stringResource(R.string.team_revoke))
            }
        }
    }
}

@Composable
private fun InviteSheet(state: TeamViewModel.State, actions: TeamActions) {
    var menuOpen by remember { mutableStateOf(false) }
    Column(
        Modifier.fillMaxWidth().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Text(stringResource(R.string.team_invite_title), style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(
            value = state.inviteEmail,
            onValueChange = actions.setInviteEmail,
            label = { Text(stringResource(R.string.team_invite_email)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                stringResource(R.string.team_invite_role, roleLabel(state.inviteRole)),
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = { menuOpen = true }) {
                Text(stringResource(R.string.team_change_role))
            }
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                for (role in state.assignableRoles) {
                    DropdownMenuItem(
                        text = { Text(roleLabel(role)) },
                        onClick = {
                            menuOpen = false
                            actions.setInviteRole(role)
                        },
                    )
                }
            }
        }
        Text(
            roleSummary(state.inviteRole),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        BrandPrimaryButton(
            text = stringResource(R.string.team_send_invite),
            modifier = Modifier.fillMaxWidth(),
            enabled = state.canSendInvite,
        ) { actions.sendInvite() }
    }
}

/** The labels the web and iOS show — Manager and Staff, not the wire names. */
@Composable
private fun roleLabel(role: WorkspaceRole): String = stringResource(
    when (role) {
        WorkspaceRole.OWNER -> R.string.team_role_owner
        WorkspaceRole.ADMIN -> R.string.team_role_admin
        WorkspaceRole.LISTING_MANAGER -> R.string.team_role_manager
        WorkspaceRole.MEMBER -> R.string.team_role_staff
        WorkspaceRole.VIEWER -> R.string.team_role_viewer
    },
)

@Composable
private fun roleSummary(role: WorkspaceRole): String = stringResource(
    when (role) {
        WorkspaceRole.OWNER -> R.string.team_role_owner_summary
        WorkspaceRole.ADMIN -> R.string.team_role_admin_summary
        WorkspaceRole.LISTING_MANAGER -> R.string.team_role_manager_summary
        WorkspaceRole.MEMBER -> R.string.team_role_staff_summary
        WorkspaceRole.VIEWER -> R.string.team_role_viewer_summary
    },
)
