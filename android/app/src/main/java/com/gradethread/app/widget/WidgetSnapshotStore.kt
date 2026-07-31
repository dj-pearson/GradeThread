package com.gradethread.app.widget

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.gradethread.app.platform.telemetry.Telemetry
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.Json

private val Context.widgetSnapshotStore by preferencesDataStore(name = "widget_snapshot")

/**
 * US-1380 (iOS `WidgetSnapshotStore`): where the published snapshot lives.
 *
 * One JSON blob rather than seven typed keys, so a read is atomic: half-updated
 * numbers on a widget are worse than slightly old ones, and seven separate
 * preference reads have no way to be consistent with each other.
 *
 * iOS needs an App Group container here because its widget is a separate
 * process with its own sandbox. Glance runs INSIDE the app process, so a plain
 * DataStore is enough — no shared container, no extra entitlement.
 */
object WidgetSnapshotStore {

    /**
     * Lenient on decode: this file survives app upgrades, and a snapshot
     * written by an older build must not take the widget down.
     */
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    private val SNAPSHOT_KEY = stringPreferencesKey("snapshot")

    /** The last published snapshot, or null when nothing has been written. */
    suspend fun read(context: Context): WidgetSnapshot? =
        context.widgetSnapshotStore.data
            .map { prefs -> prefs[SNAPSHOT_KEY] }
            .first()
            ?.let { raw ->
                runCatching { json.decodeFromString<WidgetSnapshot>(raw) }
                    .onFailure {
                        Telemetry.breadcrumb("widget snapshot unreadable: ${it.message}", "widget")
                    }
                    .getOrNull()
            }

    suspend fun write(context: Context, snapshot: WidgetSnapshot) {
        val encoded = json.encodeToString(WidgetSnapshot.serializer(), snapshot)
        context.widgetSnapshotStore.edit { it[SNAPSHOT_KEY] = encoded }
    }

    /**
     * Sign-out: the widget must stop showing the previous seller's money
     * IMMEDIATELY, and it sits on a home screen anyone can see.
     *
     * OVERWRITTEN with the signed-out snapshot rather than deleted. Deleting
     * would leave the store empty, and an empty store is indistinguishable from
     * "never published" — so the next publish would see no previous snapshot,
     * fail its unchanged check, and redraw every widget for nothing.
     */
    suspend fun clear(context: Context, nowMs: Long) {
        write(context, WidgetSnapshot.signedOut(generatedAt = nowMs))
    }
}
