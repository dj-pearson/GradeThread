package com.gradethread.app.inventory

import com.gradethread.app.platform.workspace.WorkspaceScope
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.SourcerEntity
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.postgrest.from
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-2886: the workspace's "Sourced by" roster.
 *
 * Its own repository rather than a corner of [IntakeRepository], because the
 * item canvas needs the same list and injecting an *intake* repository there
 * would be the wrong shape.
 */
@Singleton
class SourcerRepository @Inject constructor(private val client: SupabaseClient, private val db: GradeThreadDb) {

    /** The tenant every query is scoped to: active workspace, else self. */
    private fun ownerId(): String? = client.auth.currentUserOrNull()?.id?.let { WorkspaceScope.tenantOwnerId(it) }

    /**
     * The roster from the synced cache, so the picker still offers the right
     * people on a thrift trip with no signal. Archived entries come back too —
     * the picker keeps one visible while it is the item's current value.
     */
    suspend fun roster(): List<SourcerEntity> = db.sourcers().all()

    /**
     * Add a person and return the name to select, or null if nothing was written.
     *
     * ONLINE ONLY, deliberately. Everything else on the intake screen queues for
     * replay, but a roster entry is shared state whose whole job is to stop the
     * same person existing twice — two phones inventing "Tiff" on one thrift trip
     * and replaying later is exactly the duplicate the roster exists to prevent,
     * and the server's unique index cannot arbitrate a queue it never sees. The
     * caller says so rather than pretending; picking an existing name still works
     * offline.
     *
     * A duplicate is NOT an error. The unique index on `(user_id, lower(name))`
     * is the point of the roster, so a name already on it comes back in whatever
     * spelling the roster holds and the caller selects that.
     */
    suspend fun add(name: String): String? {
        val owner = ownerId() ?: return null
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return null

        val existing = runCatching {
            client.from(TABLE).select {
                filter { eq("user_id", owner) }
            }.decodeList<SourcerNameRow>()
        }.getOrNull() ?: return null

        existing.firstOrNull { it.name.equals(trimmed, ignoreCase = true) }?.let { return it.name }

        val saved = runCatching {
            client.from(TABLE)
                .insert(
                    buildJsonObject {
                        put("user_id", JsonPrimitive(owner))
                        put("name", JsonPrimitive(trimmed))
                    },
                ) { select() }
                .decodeList<SourcerNameRow>()
                .firstOrNull()
        }.getOrNull() ?: return null

        val now = System.currentTimeMillis()
        db.sourcers().upsert(
            listOf(
                SourcerEntity(
                    id = saved.id.lowercase(),
                    userId = owner,
                    name = saved.name,
                    memberUserId = null,
                    archivedAt = null,
                    createdAt = now,
                    updatedAt = now,
                ),
            ),
        )
        return saved.name
    }

    private companion object {
        const val TABLE = "sourcers"
    }
}

/** Just enough of a `sourcers` row to select the right name. */
@kotlinx.serialization.Serializable
private data class SourcerNameRow(val id: String, val name: String)
