package com.gradethread.app.platform.workspace

import android.content.Context
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow

/**
 * US-1309: the single source of truth for the active workspace owner id
 * (iOS WorkspaceScope, US-670/US-794). The EdgeApi `X-Workspace-Owner`
 * header and the sync engine's read-scoping both resolve through here, so a
 * workspace switch re-scopes ALL reads/writes consistently.
 *
 * `null` = the personal workspace (the edge defaults the tenant to the
 * caller). Persisted in SharedPreferences (the id isn't a secret; iOS uses
 * UserDefaults for the same reason).
 *
 * SCOPING RULES carried from iOS:
 *  - data queries scope by `tenantOwnerId(selfId)` = active ?? self;
 *  - DISPUTES scope by selfId (the FILER), never the workspace owner — a
 *    member's dispute belongs to them, not the tenant. Consumers (the sync
 *    stories) must use [tenantOwnerId] for everything EXCEPT disputes.
 */
object WorkspaceScope {

    /** Injectable persistence seam (tests use an in-memory store). */
    fun interface Store {
        fun get(): String?
    }

    interface MutableStore : Store {
        fun put(value: String?)
    }

    private class PrefsStore(context: Context) : MutableStore {
        private val prefs =
            context.getSharedPreferences("gradethread.workspace", Context.MODE_PRIVATE)

        override fun get(): String? =
            prefs.getString(KEY, null)?.takeIf { it.isNotEmpty() }

        override fun put(value: String?) {
            prefs.edit().apply {
                if (value.isNullOrEmpty()) remove(KEY) else putString(KEY, value)
            }.apply()
        }

        private companion object {
            const val KEY = "activeWorkspaceOwnerId"
        }
    }

    /** Events the sync layer consumes (iOS NotificationCenter names). */
    sealed class Event {
        /** The active workspace changed — reset sync cursors + cache and
         *  re-pull the new tenant's data; re-home the Realtime channel. */
        object Changed : Event()

        /** US-794: membership was revoked mid-session and the app
         *  auto-switched back to personal — the UI shows a one-time notice. */
        object AccessRevoked : Event()
    }

    private val eventsFlow = MutableSharedFlow<Event>(extraBufferCapacity = 4)
    val events: SharedFlow<Event> = eventsFlow

    @Volatile
    private var store: MutableStore? = null

    /** Call once from Application.onCreate (before any network use). */
    fun initialize(context: Context) {
        if (store == null) store = PrefsStore(context.applicationContext)
    }

    /** Test seam. */
    internal fun initializeForTest(testStore: MutableStore) {
        store = testStore
    }

    /** Selected workspace owner id, or null for the personal workspace. */
    val activeOwnerId: String?
        get() = store?.get()

    /** Tenant owner id for data scoping: the active workspace, else self. */
    fun tenantOwnerId(selfId: String): String = activeOwnerId ?: selfId

    /** Switch workspaces (null = personal). Emits [Event.Changed] only on a
     *  real change so redundant selections don't churn the cache. */
    fun setActive(ownerId: String?) {
        val normalized = ownerId?.takeIf { it.isNotEmpty() }
        if (normalized == activeOwnerId) return
        store?.put(normalized)
        eventsFlow.tryEmit(Event.Changed)
    }

    fun clear() = setActive(null)

    /**
     * US-794: the edge rejected an X-Workspace-Owner request with
     * `workspace_access_revoked`. Drop the stale scope so subsequent requests
     * run under the personal tenant, trigger the same cache-reset a switch
     * does, and post the one-time notice. No-op without an active scope.
     */
    fun handleAccessRevoked() {
        if (activeOwnerId == null) return
        store?.put(null)
        eventsFlow.tryEmit(Event.Changed)
        eventsFlow.tryEmit(Event.AccessRevoked)
    }
}
