package com.gradethread.app.money

import com.gradethread.app.sync.db.MileageTripEntity
import java.time.LocalDate

/**
 * US-3000: a mileage trip, entered on the phone at the store rather than on a
 * laptop three weeks later.
 *
 * PURE, like [ExpenseDraft], so the rules are unit-testable without a database
 * or a Compose harness. Miles are held as the RAW TEXT the seller typed: a
 * half-typed "12." must stay on screen exactly as entered rather than snapping
 * to "12.0" under the cursor.
 *
 * `tripDate` is an epoch-ms ANCHOR for a calendar date, not a moment, and every
 * read and write of it goes through [CalendarDateField]. That is AC3: `trip_date`
 * is the same shape of column as `spent_on`, and US-2339 walked `spent_on` back
 * one day per edit because the parse and the format disagreed about the zone.
 */
data class TripDraft(
    /** Non-null when editing an existing row; the id is kept so saves upsert. */
    val id: String? = null,
    val milesText: String = "",
    val purpose: String = DEFAULT_PURPOSE,
    val tripDateMs: Long,
    val startLocation: String = "",
    val endLocation: String = "",
    val roundTrip: Boolean = false,
    /** Optional attribution to the sourcing trip this drive was for. */
    val sourceId: String? = null,
) {

    /**
     * Tenths of a mile, as an integer, because the column is `numeric(8,1)`.
     *
     * Parsed to an integer here for the same reason money is parsed to cents:
     * 12.3 is not representable in binary floating point, and a log that
     * silently records 12.299999999999999 miles produces a deduction that does
     * not reconcile against the seller's own arithmetic.
     */
    val tenthsOfMile: Long?
        get() {
            val raw = milesText.trim().replace(",", "")
            if (raw.isEmpty()) return null
            val m = MILES.matchEntire(raw) ?: return null
            val whole = m.groupValues[1].ifEmpty { "0" }.toLongOrNull() ?: return null
            val frac = m.groupValues[2]
            // One decimal place. A second one is truncated rather than rounded:
            // rounding 12.35 up to 12.4 invents a distance the seller did not
            // drive, and the column cannot hold it anyway.
            val tenths = frac.firstOrNull()?.digitToIntOrNull() ?: 0
            return whole * 10 + tenths
        }

    val miles: Double? get() = tenthsOfMile?.let { it / 10.0 }

    /** @return the reason this can't be saved, or null when it's valid. */
    fun validate(): String? = when {
        tenthsOfMile == null -> "Enter the miles."
        // The server's CHECK is (miles > 0 AND miles < 100000). Rejecting here
        // rather than letting Postgres do it keeps the message in the seller's
        // words, and keeps an invalid row out of the offline queue where it
        // would retry for ever.
        tenthsOfMile == 0L -> "A trip has to be more than zero miles."
        tenthsOfMile!! >= MAX_TENTHS -> "That is more miles than a trip can be."
        purpose.isBlank() -> "Say what the trip was for."
        else -> null
    }

    val isValid: Boolean get() = validate() == null

    fun toEntity(id: String): MileageTripEntity = MileageTripEntity(
        id = id,
        tripDate = tripDateMs,
        // Tenths → miles at the boundary, so the stored Double is always an
        // exact 1-dp value and every sum over it is drift-free by construction.
        miles = (tenthsOfMile ?: 0L) / 10.0,
        purpose = purpose.trim(),
        startLocation = startLocation.trim().takeIf { it.isNotBlank() },
        endLocation = endLocation.trim().takeIf { it.isNotBlank() },
        roundTrip = roundTrip,
        sourceId = sourceId,
        createdAt = System.currentTimeMillis(),
    )

    companion object {
        const val DEFAULT_PURPOSE = "sourcing"

        private val MILES = Regex("""^(\d*)(?:\.(\d*))?$""")

        /**
         * The server's CHECK is `miles > 0 AND miles < 100000`, in TENTHS here
         * because that is how the value is carried. Rejecting on this side keeps
         * the message in the seller's words, and keeps a row Postgres will never
         * accept out of the offline queue, where it would retry for ever.
         */
        private const val MAX_TENTHS = 1_000_000L

        /**
         * What a reseller actually drives for. Wire values are stored verbatim
         * in the `purpose` column, which is free text on the server -- these are
         * the ones the picker offers, and the seller can still type their own.
         */
        val PURPOSES: List<Pair<String, String>> = listOf(
            "sourcing" to "Sourcing trip",
            "post_office" to "Post office",
            "supplies" to "Buying supplies",
            "consignor" to "Consignor pickup or drop-off",
            "other" to "Something else",
        )

        fun label(wire: String): String = PURPOSES.firstOrNull { it.first == wire }?.second ?: wire

        /** A new trip for today, in the date field's own zone. */
        fun today(sourceId: String? = null): TripDraft = TripDraft(
            tripDateMs = CalendarDateField.todayMs(),
            sourceId = sourceId,
        )

        /** The epoch-ms anchor for a calendar date. Never the device zone. */
        fun anchor(date: LocalDate): Long = CalendarDateField.startOfDayMs(date)
    }
}
