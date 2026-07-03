package com.gradethread.app.sync

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.preferencesDataStore
import com.gradethread.app.sync.db.InventoryItemEntity
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.realtime.PostgresAction
import io.github.jan.supabase.realtime.RealtimeChannel
import io.github.jan.supabase.realtime.channel
import io.github.jan.supabase.realtime.postgresChangeFlow
import io.github.jan.supabase.realtime.realtime
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.time.Instant
import java.time.OffsetDateTime

private val Context.realtimeDataStore by preferencesDataStore(name = "realtime")

/**
 * US-1321: live inventory updates (iOS RealtimeService). One channel scoped
 * to the active owner's inventory rows; insert/update upserts through the
 * merge policy, delete removes locally.
 *
 * The US-1211 rule: EVERY transition INTO subscribed — the first subscribe
 * AND every re-subscribe after a drop (token expiry, cellular handoff,
 * backgrounding) — kicks a catch-up pull. Postgres-change events emitted
 * while the socket was down are never replayed by the server; without the
 * catch-up they'd be lost until the next manual sync.
 *
 * Lifecycle: subscribe on sign-in/foreground, [pause] on background (battery
 * + data go to zero), [rehome] on workspace switch. User toggle persists in
 * DataStore, default ON. All JSON decode runs off the main thread.
 */
class RealtimeService(
    private val client: SupabaseClient,
    private val merger: SyncMerger,
    private val onCatchUpNeeded: suspend () -> Unit,
    private val scope: CoroutineScope,
) {

    enum class Phase { IDLE, SUBSCRIBING, SUBSCRIBED, RECONNECTING, DISABLED }

    private val phaseFlow = MutableStateFlow(Phase.IDLE)
    val phase: StateFlow<Phase> = phaseFlow

    private var channel: RealtimeChannel? = null
    private var jobs = mutableListOf<Job>()

    companion object {
        private val ENABLED_KEY = booleanPreferencesKey("realtime_enabled")

        /** US-1211, pure: catch-up fires on any transition INTO subscribed. */
        fun shouldCatchUp(previous: Phase, new: Phase): Boolean =
            new == Phase.SUBSCRIBED && previous != Phase.SUBSCRIBED

        /** supabase-kt status → phase (kept open for SDK case drift). */
        fun phaseFor(status: RealtimeChannel.Status): Phase = when (status) {
            RealtimeChannel.Status.SUBSCRIBED -> Phase.SUBSCRIBED
            RealtimeChannel.Status.SUBSCRIBING -> Phase.SUBSCRIBING
            RealtimeChannel.Status.UNSUBSCRIBED,
            RealtimeChannel.Status.UNSUBSCRIBING,
            -> Phase.IDLE
        }

        suspend fun isEnabled(context: Context): Boolean =
            context.realtimeDataStore.data.first()[ENABLED_KEY] ?: true

        suspend fun setEnabled(context: Context, enabled: Boolean) {
            context.realtimeDataStore.edit { it[ENABLED_KEY] = enabled }
        }
    }

    /** Open the owner-scoped channel; no-ops when one is already up. */
    suspend fun start(ownerId: String) {
        if (channel != null) return
        phaseFlow.value = Phase.SUBSCRIBING

        val ch = client.channel("inventory:$ownerId")
        channel = ch

        // Owner filter: we never see other tenants' events even if the
        // server-side channel were misconfigured — defense in depth on top
        // of RLS.
        val changes = ch.postgresChangeFlow<PostgresAction>(schema = "public") {
            table = "inventory_items"
            filter("user_id", io.github.jan.supabase.postgrest.query.filter.FilterOperator.EQ, ownerId)
        }

        jobs += scope.launch {
            ch.status.collect { status ->
                val previous = phaseFlow.value
                val next = phaseFor(status)
                phaseFlow.value = next
                if (shouldCatchUp(previous, next)) onCatchUpNeeded()
            }
        }
        jobs += scope.launch(Dispatchers.Default) { // decode off-main (AC4)
            changes.collect { action -> dispatch(action) }
        }

        runCatching { ch.subscribe() }.onFailure {
            // Redacted phase only — the raw error can embed the topic/token.
            phaseFlow.value = Phase.RECONNECTING
        }
    }

    /** Background: tear the socket down entirely. */
    suspend fun pause() {
        jobs.forEach { it.cancel() }
        jobs.clear()
        channel?.let { runCatching { client.realtime.removeChannel(it) } }
        channel = null
        phaseFlow.value = Phase.IDLE
    }

    /** US-1211: workspace switch — re-home the channel onto the new owner. */
    suspend fun rehome(ownerId: String) {
        pause()
        start(ownerId)
    }

    internal suspend fun dispatch(action: PostgresAction) {
        when (action) {
            is PostgresAction.Insert -> upsert(action.record)
            is PostgresAction.Update -> upsert(action.record)
            is PostgresAction.Delete -> {
                // Server-authoritative: the row is gone (FK cascade drops its
                // photos locally too).
                RealtimeRows.idOf(action.oldRecord)?.let { merger.deleteItemLocally(it) }
            }
            else -> Unit // SELECT/broadcast — not ours
        }
    }

    private suspend fun upsert(record: JsonObject) {
        RealtimeRows.decodeInventoryRow(record)?.let { entity ->
            merger.apply(SyncMerger.PulledBatch(items = listOf(entity)))
        }
    }
}

/**
 * US-1321: row decoding for realtime events (lenient — a malformed event is
 * dropped, mirroring the pull's row rule; the catch-up pull repairs).
 */
object RealtimeRows {

    @Serializable
    internal data class RemoteInventoryRow(
        val id: String,
        @SerialName("user_id") val userId: String,
        val title: String? = null,
        val brand: String? = null,
        val sku: String? = null,
        val size: String? = null,
        val color: String? = null,
        val material: String? = null,
        val status: String? = null,
        @SerialName("item_category") val itemCategory: String? = null,
        @SerialName("garment_type") val garmentType: String? = null,
        @SerialName("garment_category") val garmentCategory: String? = null,
        val description: String? = null,
        val style: String? = null,
        @SerialName("sourced_by") val sourcedBy: String? = null,
        @SerialName("acquired_date") val acquiredDate: String? = null,
        val container: String? = null,
        @SerialName("source_id") val sourceId: String? = null,
        @SerialName("location_bin") val locationBin: String? = null,
        @SerialName("consignor_id") val consignorId: String? = null,
        @SerialName("consignment_split_pct") val consignmentSplitPct: Double? = null,
        @SerialName("acquired_price") val acquiredPrice: Double? = null,
        @SerialName("target_price") val targetPrice: Double? = null,
        @SerialName("grade_value") val gradeValue: Double? = null,
        @SerialName("grade_label") val gradeLabel: String? = null,
        @SerialName("certificate_url") val certificateUrl: String? = null,
        @SerialName("grade_report_id") val gradeReportId: String? = null,
        @SerialName("condition_notes") val conditionNotes: String? = null,
        @SerialName("created_at") val createdAt: String? = null,
        @SerialName("updated_at") val updatedAt: String? = null,
    )

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    /** Lenient: null on any decode failure (the catch-up pull repairs). */
    fun decodeInventoryRow(record: JsonObject): InventoryItemEntity? = runCatching {
        val row = json.decodeFromJsonElement(RemoteInventoryRow.serializer(), record)
        InventoryItemEntity(
            id = row.id.lowercase(),
            userId = row.userId,
            title = row.title ?: "",
            brand = row.brand,
            sku = row.sku,
            size = row.size,
            color = row.color,
            material = row.material,
            status = row.status ?: "sourced",
            itemCategory = row.itemCategory,
            garmentType = row.garmentType,
            garmentCategory = row.garmentCategory,
            itemDescription = row.description,
            style = row.style,
            sourcedBy = row.sourcedBy,
            acquiredDate = parseTimestamp(row.acquiredDate),
            container = row.container,
            compSetJson = null,
            sourceId = row.sourceId,
            locationBin = row.locationBin,
            consignorId = row.consignorId,
            consignmentSplitPct = row.consignmentSplitPct,
            acquiredPrice = row.acquiredPrice,
            targetPrice = row.targetPrice,
            listingPrice = null,
            gradeValue = row.gradeValue,
            gradeLabel = row.gradeLabel,
            certificateUrl = row.certificateUrl,
            gradeReportId = row.gradeReportId,
            disputeStatus = null,
            conditionNotes = row.conditionNotes,
            measurementsJson = null,
            primaryPhotoUrl = null,
            createdAt = parseTimestamp(row.createdAt) ?: 0L,
            updatedAt = parseTimestamp(row.updatedAt) ?: 0L,
        )
    }.getOrNull()

    fun idOf(record: JsonObject): String? =
        runCatching { record["id"]?.jsonPrimitive?.content?.lowercase() }.getOrNull()

    /** ISO-8601 with offset (+00:00 / Z) or date-only → epoch ms. */
    fun parseTimestamp(value: String?): Long? {
        if (value.isNullOrBlank()) return null
        return runCatching { OffsetDateTime.parse(value).toInstant().toEpochMilli() }
            .recoverCatching { Instant.parse(value).toEpochMilli() }
            .recoverCatching { java.time.LocalDate.parse(value).atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli() }
            .getOrNull()
    }
}
