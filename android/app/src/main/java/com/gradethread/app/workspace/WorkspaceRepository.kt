package com.gradethread.app.workspace

import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.platform.workspace.WorkspaceScope
import com.gradethread.app.sync.MutationReplayer
import com.gradethread.app.sync.SessionScope
import com.gradethread.app.sync.SyncTrigger
import com.gradethread.app.sync.SyncWatermark
import com.gradethread.app.sync.db.GradeThreadDb
import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.query.Columns
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-1388: reading the workspaces this user can work inside, and moving
 * between them.
 *
 * The list comes from `workspace_members` through the ANON client, so RLS
 * scopes it — a service-role read here would happily return every membership
 * on the server.
 */
interface WorkspaceReading {
    suspend fun list(selfId: String): List<WorkspaceSummary>
}

@Singleton
class WorkspaceRepository @Inject constructor(
    private val client: SupabaseClient,
) : WorkspaceReading {

    override suspend fun list(selfId: String): List<WorkspaceSummary> {
        val memberships = runCatching {
            client.from("workspace_members").select(Columns.raw("owner_id")) {
                filter { eq("member_id", selfId) }
            }.decodeList<MemberRow>()
        }.getOrElse { error ->
            Telemetry.breadcrumb("workspace list failed: ${error.message}", "workspace")
            // The personal workspace is still returned by build(), so the app
            // stays usable offline rather than losing its own data too.
            emptyList()
        }

        val ownerIds = memberships.map { it.ownerId }.filter { it != selfId }
        val names = if (ownerIds.isEmpty()) {
            emptyMap()
        } else {
            runCatching {
                client.from("users").select(Columns.raw("id, full_name")) {
                    filter { isIn("id", ownerIds) }
                }.decodeList<OwnerRow>().associate { it.id to it.fullName }
            }.getOrDefault(emptyMap())
        }

        return Workspaces.build(selfId, ownerIds, names)
    }

    @Serializable
    private data class MemberRow(@SerialName("owner_id") val ownerId: String = "")

    @Serializable
    private data class OwnerRow(
        val id: String = "",
        @SerialName("full_name") val fullName: String? = null,
    )
}

/**
 * US-1388: the switch itself.
 *
 * [SessionScope.switchWorkspace] has existed since US-1323 with its ordering
 * contract written down and NO production caller. This is the caller. The
 * ordering is not incidental: the queued edits belong to the OLD tenant, so
 * they flush before anything is wiped, and the epoch bump makes any pull still
 * in flight discard its merge rather than write the outgoing workspace's rows
 * back on top of the incoming one's.
 */
@Singleton
class WorkspaceSwitcher @Inject constructor(
    @ApplicationContext private val context: Context,
    private val db: GradeThreadDb,
    private val client: SupabaseClient,
    private val replayer: MutationReplayer,
    private val realtime: com.gradethread.app.sync.RealtimeCoordinator,
    private val syncTrigger: SyncTrigger,
) {

    private val sessionScope = SessionScope(db, SyncWatermark(context))

    /**
     * Move to [ownerId] and re-scope everything under it.
     *
     * The scope is set FIRST, because every read the re-pull performs resolves
     * its tenant through [WorkspaceScope]. Setting it after the pull would
     * fetch the outgoing workspace's rows into the incoming one's cache.
     */
    suspend fun switchTo(ownerId: String) {
        val selfId = client.auth.currentUserOrNull()?.id ?: return
        val scoped = Workspaces.scopeValue(ownerId, selfId)
        if (scoped == WorkspaceScope.activeOwnerId) return

        WorkspaceScope.setActive(scoped)
        // US-2496: the edge response cache is keyed by the tenant, so the new
        // workspace already cannot READ the old one's cached answers. This is
        // the retention half: the workspace being left holds response bodies in
        // memory for up to their TTL, and a switch is the moment to let them go.
        EdgeApi.clearAllResponseCaches()
        sessionScope.switchWorkspace(
            newOwnerId = ownerId,
            hooks = SessionScope.Hooks(
                flushPending = { runCatching { replayer.replay() } },
                // US-2367: a real channel to re-home at last. The coordinator
                // no-ops when the socket is down, so a switch made in the
                // background does not open one.
                rehomeRealtime = { runCatching { realtime.rehome() } },
                pullForOwner = { runCatching { syncTrigger.refresh(reason = "workspace_switch") } },
            ),
        )
        Telemetry.event("workspace_switched", mapOf("personal" to (scoped == null)))
    }
}
