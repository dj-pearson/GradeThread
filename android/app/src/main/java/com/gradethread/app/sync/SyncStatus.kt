package com.gradethread.app.sync

/**
 * US-1322: the shell status-bar states (iOS SyncStatusBar). Quiet by
 * default — [IDLE] renders nothing; loud only when something needs the
 * user's attention.
 */
enum class SyncStatus {
    /** Nothing to show — the bar disappears entirely. */
    IDLE,

    /** A flush/pull is in flight. */
    SYNCING,

    /** Queued local changes waiting for connectivity/replay. */
    PENDING,

    /** Offline with the cached mirror. */
    OFFLINE,

    /** The realtime socket is re-establishing. */
    RECONNECTING,

    /** US-1147: stuck changes (auto-retry exhausted) — needs the inspector. */
    NEEDS_ATTENTION,
    ;

    companion object {
        /**
         * Priority per iOS: stuck changes beat the routine phase (they need a
         * deliberate retry/discard); then the active sync, then queued work,
         * then link state.
         */
        fun derive(
            stuckCount: Int,
            syncing: Boolean,
            pendingCount: Int,
            online: Boolean,
            reconnecting: Boolean,
        ): SyncStatus = when {
            stuckCount > 0 -> NEEDS_ATTENTION
            syncing -> SYNCING
            pendingCount > 0 && !online -> OFFLINE
            pendingCount > 0 -> PENDING
            !online -> OFFLINE
            reconnecting -> RECONNECTING
            else -> IDLE
        }
    }
}
