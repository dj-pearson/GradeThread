package com.gradethread.app.money

import androidx.annotation.StringRes
import com.gradethread.app.R
import com.gradethread.app.platform.workspace.WorkspaceScope
import com.gradethread.app.sync.MutationKind
import com.gradethread.app.sync.OfflineMutationQueue
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.MileageTripEntity
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.postgrest.from
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-3000: mileage trips, logged where they happen.
 *
 * A trip is recorded in a car park with one bar of signal, so this is the same
 * shape as [ExpenseRepository]: local mirror FIRST, then the server. A transient
 * failure rides the mutation queue; anything else rolls the local row back, so
 * the log never claims a trip the server rejected outright.
 *
 * OFFLINE IS THE POINT, not a nicety. A mileage log filled in three weeks later
 * is the reconstructed record the IRS specifically discounts, and "you had no
 * signal" is the most common reason a seller never goes back and enters it.
 *
 * The SERVER table and the local Room table are both `mileage_trips` -- unlike
 * expenses, where the two names differ and the mismatch shows up as a silent
 * 404.
 */
@Singleton
class MileageRepository @Inject constructor(
    private val client: SupabaseClient,
    private val db: GradeThreadDb,
    private val queue: OfflineMutationQueue,
) {

    /** The outcome the form needs to distinguish for its confirmation copy. */
    sealed interface Outcome {
        data class Saved(val id: String) : Outcome

        /** Stored locally and queued — a truthful "saved, will sync" state. */
        data class Queued(val id: String) : Outcome

        /**
         * ⚠ TWO KINDS OF FAILURE, AND ONLY ONE CAN BE TRANSLATED.
         *
         * [messageRes] is our own copy and is a resource id, because this class
         * is plain Kotlin and cannot reach a Context - English returned from
         * here reaches a Spanish seller untranslated. [detail] is the SERVER's
         * sentence, which we did not write and cannot localize; it is shown as
         * received when present. The caller renders detail ?: messageRes.
         */
        data class Failed(@StringRes val messageRes: Int, val detail: String? = null) : Outcome
    }

    private fun ownerId(): String? = client.auth.currentUserOrNull()?.id?.let { WorkspaceScope.tenantOwnerId(it) }

    fun observeTrips() = db.mileageTrips().observeAll()

    suspend fun save(draft: TripDraft): Outcome {
        val owner = ownerId() ?: return Outcome.Failed(R.string.money_signed_out_save)
        val validation = draft.validate()
        if (validation != null) return Outcome.Failed(validation)

        // An edit keeps its id so the upsert replaces rather than duplicates.
        // Lowercased at the MINT site, because the server compares ids as text
        // and an uppercase UUID from a client is a second row for the same trip.
        val id = draft.id ?: UUID.randomUUID().toString().lowercase()
        val entity = draft.toEntity(id)
        val previous = if (draft.id != null) db.mileageTrips().byId(id) else null

        db.mileageTrips().upsert(listOf(entity))

        val body = wireBody(entity, owner)
        return runCatching { client.from(TABLE).upsert(body) }.fold(
            onSuccess = { Outcome.Saved(id) },
            onFailure = { error ->
                if (OfflineMutationQueue.shouldEnqueue(error)) {
                    queue.enqueue(
                        kind = MutationKind.CREATE_MILEAGE_TRIP,
                        targetId = id,
                        payload = body.toString().encodeToByteArray(),
                    )
                    Outcome.Queued(id)
                } else {
                    // A validation or RLS rejection is permanent: keeping the
                    // local row would put miles in the seller's deduction that
                    // no server will ever agree with.
                    if (previous != null) {
                        db.mileageTrips().upsert(listOf(previous))
                    } else {
                        db.mileageTrips().deleteByIds(listOf(id))
                    }
                    Outcome.Failed(R.string.mileage_save_failed, message(error))
                }
            },
        )
    }

    suspend fun delete(id: String): Outcome {
        val owner = ownerId() ?: return Outcome.Failed(R.string.money_signed_out_action)
        val previous = db.mileageTrips().byId(id)
        db.mileageTrips().deleteByIds(listOf(id))

        return runCatching {
            client.from(TABLE).delete {
                filter {
                    eq("id", id)
                    // Tenant scope. Never act on an id alone (US-268).
                    eq("user_id", owner)
                }
            }
        }.fold(
            onSuccess = { Outcome.Saved(id) },
            onFailure = { error ->
                if (OfflineMutationQueue.shouldEnqueue(error)) {
                    queue.enqueue(
                        kind = MutationKind.DELETE_MILEAGE_TRIP,
                        targetId = id,
                        // The same {"id": ...} shape the expense delete uses,
                        // because the replayer decodes every delete payload as
                        // JSON. A bare id string would fail to parse and the
                        // mutation would sit in the queue for ever.
                        payload = """{"id":"$id"}""".encodeToByteArray(),
                    )
                    Outcome.Queued(id)
                } else {
                    if (previous != null) db.mileageTrips().upsert(listOf(previous))
                    Outcome.Failed(R.string.mileage_save_failed, message(error))
                }
            },
        )
    }

    /**
     * The insert/upsert body.
     *
     * `trip_date` is a DATE column, so it is sent as `YYYY-MM-DD` through
     * [CalendarDateField] -- the same path expenses use, for the reason US-2339
     * exists. Sending a full timestamp makes Postgres truncate it in UTC, which
     * silently moves an evening trip to the next day east of Greenwich.
     */
    private fun wireBody(entity: MileageTripEntity, owner: String): JsonObject = JsonObject(
        buildMap {
            put("id", JsonPrimitive(entity.id))
            put("user_id", JsonPrimitive(owner))
            put("trip_date", JsonPrimitive(CalendarDateField.iso(entity.tripDate)))
            put("miles", JsonPrimitive(entity.miles))
            put("purpose", JsonPrimitive(entity.purpose))
            // Explicit nulls rather than omitted keys: on an edit, omitting the
            // key leaves the old value, so clearing a location would silently
            // fail. Same rule the expense attribution follows.
            put("start_location", entity.startLocation?.let { JsonPrimitive(it) } ?: JsonNull)
            put("end_location", entity.endLocation?.let { JsonPrimitive(it) } ?: JsonNull)
            put("round_trip", JsonPrimitive(entity.roundTrip))
            put("source_id", entity.sourceId?.let { JsonPrimitive(it) } ?: JsonNull)
        },
    )

    /**
     * The server sentence when there is one. Null lets the caller fall back to
     * [R.string.mileage_save_failed], which is ours and therefore translatable.
     */
    private fun message(error: Throwable): String? = error.message

    companion object {
        const val TABLE = "mileage_trips"
    }
}
