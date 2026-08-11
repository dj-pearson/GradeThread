package com.gradethread.app.workspace

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.auth.AuthRepository
import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.platform.workspace.WorkspaceScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.time.Instant
import javax.inject.Inject

/**
 * US-2407: running the workspace from the phone.
 *
 * **The server decides what the list shows, not local optimism.** Every
 * mutation reloads from the source instead of patching state in place: the
 * edge enforces a role cap, a last-admin guard and an owner-immunity rule that
 * this screen deliberately does not re-implement, so a locally-applied change
 * could show a role the server never granted. A brief spinner is the cheaper
 * mistake.
 */
@HiltViewModel
class TeamViewModel @Inject constructor(
    private val manager: TeamManaging,
    private val directory: TeamReading,
    private val auth: AuthRepository,
) : ViewModel() {

    data class State(
        val loading: Boolean = true,
        val selfId: String? = null,
        val selfEmail: String? = null,
        val ownerId: String? = null,
        val members: List<TeamMember> = emptyList(),
        val invitations: List<WorkspaceInvitationRow> = emptyList(),
        /** One in-flight action at a time, keyed so only its row spins. */
        val busyKey: String? = null,
        val errorMessage: String? = null,
        /** Set when an invite landed but the EMAIL did not — see [acceptUrl]. */
        val acceptUrl: String? = null,
        val inviteEmail: String = "",
        val inviteRole: WorkspaceRole = WorkspaceRole.LISTING_MANAGER,
        val inviteOpen: Boolean = false,
    ) {
        /** Whether the signed-in user owns the workspace being looked at. */
        val isOwner: Boolean get() = ownerId != null && ownerId == selfId

        /** The caller's own role, read off the roster rather than re-queried. */
        val myRole: WorkspaceRole
            get() = when {
                isOwner -> WorkspaceRole.OWNER
                else -> members.firstOrNull { it.memberId == selfId }?.role ?: WorkspaceRole.VIEWER
            }

        val canManage: Boolean get() = myRole.canManageMembers

        /**
         * Pending invitations are OWNER-ONLY, and that is an RLS fact rather
         * than a policy choice here: `workspace_invitations` has no admin
         * SELECT policy, so an admin's query comes back empty. Showing them an
         * empty card would read as "no invitations" when the truth is "not
         * yours to see".
         */
        val showsInvitations: Boolean get() = isOwner

        val assignableRoles: List<WorkspaceRole> get() = Team.assignableBy(myRole)

        fun canAct(member: TeamMember): Boolean = Team.canAct(myRole, member)

        fun isBusy(key: String): Boolean = busyKey == key

        val canSendInvite: Boolean
            get() = canManage && busyKey == null && WorkspaceEmail.isValid(inviteEmail)
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            auth.phase.collect { phase ->
                val signedIn = phase as? AuthRepository.Phase.SignedIn ?: return@collect
                _state.value = _state.value.copy(
                    selfId = signedIn.userId,
                    selfEmail = signedIn.email,
                    ownerId = WorkspaceScope.tenantOwnerId(signedIn.userId),
                )
                load()
            }
        }
    }

    fun load() {
        val selfId = _state.value.selfId ?: return
        val ownerId = _state.value.ownerId ?: return
        viewModelScope.launch {
            _state.value = _state.value.copy(loading = true)
            val rows = runCatching { directory.members(ownerId) }.getOrDefault(emptyList())
            val roster = Team.roster(
                ownerId = ownerId,
                // The owner's own name is not in the members join, so their row
                // is labelled from the session when they are the one looking.
                ownerName = null,
                ownerEmail = if (ownerId == selfId) _state.value.selfEmail else null,
                rows = rows,
            )
            // Fetched only for the owner: for anyone else the query is refused
            // by RLS and would spend a round trip to return nothing.
            val invitations = if (ownerId == selfId) {
                runCatching { directory.invitations(ownerId) }.getOrDefault(emptyList())
            } else {
                emptyList()
            }
            _state.value = _state.value.copy(
                loading = false,
                members = roster,
                invitations = Team.open(invitations, System.currentTimeMillis()),
            )
        }
    }

    fun openInvite() = update { it.copy(inviteOpen = true, acceptUrl = null, errorMessage = null) }

    fun closeInvite() = update { it.copy(inviteOpen = false, inviteEmail = "") }

    fun setInviteEmail(value: String) = update { it.copy(inviteEmail = value) }

    fun setInviteRole(role: WorkspaceRole) = update { it.copy(inviteRole = role) }

    fun dismissError() = update { it.copy(errorMessage = null) }

    fun dismissAcceptUrl() = update { it.copy(acceptUrl = null) }

    fun sendInvite() {
        val current = _state.value
        if (!current.canSendInvite) return
        act("invite") {
            val created = manager.invite(current.inviteEmail, current.inviteRole)
            // The email is best-effort on the server, so a 200 does NOT mean it
            // arrived. When it didn't, the link is the only way the teammate
            // gets in and the screen has to hand it over.
            update {
                it.copy(
                    inviteOpen = false,
                    inviteEmail = "",
                    acceptUrl = if (created.emailSent) null else created.acceptUrl,
                )
            }
        }
    }

    fun resend(invitationId: String) = act("resend:$invitationId") {
        val result = manager.resend(invitationId)
        update { it.copy(acceptUrl = if (result.emailSent) null else result.acceptUrl) }
    }

    fun revoke(invitationId: String) = act("revoke:$invitationId") {
        directory.revoke(invitationId, Instant.now().toString())
    }

    fun changeRole(memberId: String, role: WorkspaceRole) =
        act("role:$memberId") { manager.updateRole(memberId, role) }

    fun remove(memberId: String) = act("remove:$memberId") { manager.remove(memberId) }

    /**
     * Run one mutation, then reload.
     *
     * The reload happens on success AND on failure. A refusal often means the
     * screen is out of date — the member was already removed, the invitation
     * already accepted — so re-reading is what makes the next attempt sensible
     * rather than a repeat of the same rejected action.
     */
    private fun act(key: String, block: suspend () -> Unit) {
        if (_state.value.busyKey != null) return
        _state.value = _state.value.copy(busyKey = key, errorMessage = null)
        viewModelScope.launch {
            val result = runCatching { block() }
            _state.value = _state.value.copy(
                busyKey = null,
                errorMessage = result.exceptionOrNull()?.let(::message),
            )
            load()
        }
    }

    private fun update(transform: (State) -> State) {
        _state.value = transform(_state.value)
    }

    /**
     * The server's own sentence wherever there is one.
     *
     * The workspace routes refuse in copy that names the rule ("Appoint another
     * admin before stepping down from admin."), and nothing on the device could
     * work that out. US-2407 added [EdgeApiError.Forbidden] so a 403 stops
     * arriving as "your session expired".
     */
    private fun message(error: Throwable): String =
        (error as? EdgeApiError)?.userMessage()
            ?: error.message
            ?: "That didn't work. Try again."
}
