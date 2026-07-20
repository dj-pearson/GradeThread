package com.gradethread.app.capture

import com.gradethread.app.sync.db.CaptureDraftEntity
import com.gradethread.app.sync.db.GradeThreadDb
import kotlinx.serialization.json.Json

/**
 * US-1330: autosave + recovery for the details intake form (iOS
 * `IntakeDraftStore`).
 *
 * Stored in the EXISTING `capture_drafts` table under its own row id, not a
 * new entity — the table is deliberately generic (`id` + `stateJson`), so this
 * needs no Room version bump and no migration. It also inherits the sign-out
 * wipe for free: `SessionScope.wipeAllTables` already clears `capture_drafts`
 * because an in-flight intake is tenant data.
 */
object DetailsDraftStore {

    /** Sibling of `PhotoIntakeStore.DRAFT_ID` ("active"). One draft at a time. */
    const val DRAFT_ID = "details"

    private val json = Json { ignoreUnknownKeys = true }

    /**
     * Persist the form. An EMPTY form is deleted rather than written, so
     * opening intake and backing out doesn't leave a draft that prompts
     * "resume your unsaved item?" over nothing.
     */
    suspend fun save(
        db: GradeThreadDb,
        state: DetailsIntakeState,
        clock: () -> Long = System::currentTimeMillis,
    ) {
        if (!state.hasContent) {
            clear(db)
            return
        }
        db.captureDrafts().upsert(
            CaptureDraftEntity(
                id = DRAFT_ID,
                stateJson = json.encodeToString(DetailsIntakeState.serializer(), state),
                updatedAt = clock(),
            ),
        )
    }

    /**
     * The recovered draft, or null. A draft written by a NEWER build that
     * added fields decodes fine (`ignoreUnknownKeys`); one that is corrupt or
     * otherwise undecodable yields null rather than crashing the screen — a
     * lost draft is an annoyance, a crash loop on open is not.
     */
    suspend fun load(db: GradeThreadDb): DetailsIntakeState? {
        val row = db.captureDrafts().byId(DRAFT_ID) ?: return null
        return runCatching {
            json.decodeFromString(DetailsIntakeState.serializer(), row.stateJson)
        }.getOrNull()?.takeIf { it.hasContent }
    }

    /** Cleared on save success, on merge success, and on explicit discard. */
    suspend fun clear(db: GradeThreadDb) {
        db.captureDrafts().delete(DRAFT_ID)
    }
}
