package com.gradethread.app.workspace

import com.gradethread.app.ui.UiMessage

import com.gradethread.app.R

/**
 * US-1388 (iOS `WorkspaceSummary` / `WorkspaceContext`): a workspace the
 * signed-in user can work inside.
 *
 * `ownerId` is the TENANT, not the member — every scoped read and every
 * `X-Workspace-Owner` header carries it.
 */
data class WorkspaceSummary(val ownerId: String, val name: String, val isPersonal: Boolean)

/**
 * US-1388: the switcher's rules.
 *
 * Pure, because getting this wrong shows one seller another seller's stock. A
 * stale selection in particular is not hypothetical — membership can be revoked
 * while the app is closed, and the id stays in preferences until something
 * notices.
 */
object Workspaces {

    const val PERSONAL_NAME = "My workspace"

    /** What a shared workspace is called when its owner has no name set. */
    const val UNNAMED_SHARED = "Shared workspace"

    /**
     * The full list: the personal workspace first, then everything else.
     *
     * Personal is ALWAYS present and always first. It is the one workspace that
     * cannot be revoked, so it is the one the app can always fall back to — and
     * a list that could come back empty would leave the switcher with nothing
     * to switch to when a membership lapses.
     */
    fun build(selfId: String, memberOwnerIds: List<String>, ownerNames: Map<String, String?>): List<WorkspaceSummary> {
        val personal = WorkspaceSummary(selfId, PERSONAL_NAME, isPersonal = true)
        val shared = memberOwnerIds
            // A membership row pointing at yourself is not a second workspace.
            .filter { it != selfId && it.isNotBlank() }
            .distinct()
            .map { ownerId ->
                WorkspaceSummary(
                    ownerId = ownerId,
                    name = ownerNames[ownerId]?.takeIf { it.isNotBlank() } ?: UNNAMED_SHARED,
                    isPersonal = false,
                )
            }
            .sortedBy { it.name.lowercase() }
        return listOf(personal) + shared
    }

    /** The switcher is worth showing only when there is somewhere to switch to. */
    fun hasChoice(workspaces: List<WorkspaceSummary>): Boolean = workspaces.size > 1

    /**
     * Whether the stored selection still exists.
     *
     * A revoked membership leaves an owner id in preferences that every request
     * then sends as `X-Workspace-Owner`. The edge rejects those, but the app
     * would keep sending them until something dropped the id — so the list load
     * is where it gets dropped.
     */
    fun isStale(activeOwnerId: String?, workspaces: List<WorkspaceSummary>): Boolean {
        if (activeOwnerId == null) return false
        return workspaces.none { it.ownerId == activeOwnerId }
    }

    fun active(workspaces: List<WorkspaceSummary>, activeOwnerId: String?, selfId: String): WorkspaceSummary? {
        val target = activeOwnerId ?: selfId
        return workspaces.firstOrNull { it.ownerId == target }
    }

    /**
     * What [WorkspaceScope] should store for a chosen workspace.
     *
     * The personal workspace stores NULL rather than the user's own id: the
     * edge defaults the tenant to the caller, and sending a header that names
     * yourself is a different code path on the server for the same result.
     */
    fun scopeValue(ownerId: String, selfId: String): String? = ownerId.takeIf { it != selfId && it.isNotBlank() }

    /** Shown once after an involuntary switch, so it doesn't look like a bug. */
    val ACCESS_REVOKED = UiMessage(R.string.workspace_access_revoked)

    /**
     * The line under the switcher.
     *
     * Names the workspace even when there is only one, because "whose data am I
     * looking at" is the question this control exists to answer, and a control
     * that disappears when the answer is "yours" makes it ambiguous.
     */
    fun subtitle(active: WorkspaceSummary?): UiMessage = when {
        active == null -> UiMessage(R.string.workspace_subtitle_loading)
        active.isPersonal -> UiMessage(R.string.workspace_subtitle_personal)
        else -> UiMessage(R.string.workspace_subtitle_shared)
    }
}
