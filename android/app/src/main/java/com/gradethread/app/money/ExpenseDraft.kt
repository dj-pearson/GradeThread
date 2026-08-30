package com.gradethread.app.money

import com.gradethread.app.capture.CurrencyAmount
import com.gradethread.app.sync.db.ExpenseEntity
import java.time.ZoneId

/**
 * US-1364: the expense form's state and its validation — pure, so the rules are
 * unit-testable without a database or a Compose harness (the same split the
 * intake form uses).
 *
 * The amount is held as the RAW TEXT the seller typed, not a parsed Double: a
 * half-typed "12." must stay on screen exactly as entered rather than snapping
 * to "12.0" under the cursor. Parsing happens at the edges — [validate] and
 * [toEntity] — through [CurrencyAmount], which carries the US-1184 negative
 * clamp so a pasted "-20" can't invert the P&L.
 */
data class ExpenseDraft(
    /** Non-null when editing an existing row; the id is kept so saves upsert. */
    val id: String? = null,
    val category: String = DEFAULT_CATEGORY,
    val amountText: String = "",
    val description: String = "",
    val spentOnMs: Long,
    /** Optional attribution to an item, for per-item P&L. */
    val inventoryItemId: String? = null,
    val listingId: String? = null,
) {

    val amountCents: Long? get() = CurrencyAmount.parseCents(amountText)

    /** @return the reason this can't be saved, or null when it's valid. */
    fun validate(): String? = when {
        category.isBlank() -> "Pick a category."
        amountCents == null -> "Enter an amount."
        // Zero is rejected rather than clamped: a 0.00 expense is always a
        // mistyped entry, and silently storing it puts a meaningless row in the
        // ledger the seller then has to hunt down.
        amountCents == 0L -> "Enter an amount greater than zero."
        else -> null
    }

    val isValid: Boolean get() = validate() == null

    fun toEntity(id: String): ExpenseEntity = ExpenseEntity(
        id = id,
        category = category,
        expenseDescription = description.trim().takeIf { it.isNotBlank() },
        // Cents → dollars at the boundary, so the stored Double is always an
        // exact 2-dp value and every Money.sum over it is drift-free by
        // construction.
        amount = (amountCents ?: 0L) / 100.0,
        spentOn = spentOnMs,
        inventoryItemId = inventoryItemId,
        listingId = listingId,
        createdAt = System.currentTimeMillis(),
    )

    companion object {
        const val DEFAULT_CATEGORY = "supplies"

        /**
         * The zone `spentOn` is anchored in. UTC, everywhere, always.
         *
         * US-2339: `spent_on` is a date-only column, and `spentOn` is a Long
         * carrying a CALENDAR DATE rather than a moment. The round trip was
         * split across two zones and lost a day per cycle: the sync parses the
         * server's bare date at UTC midnight
         * (`RealtimeService.parseTimestamp`), and `isoDate` then formatted it
         * back in the DEVICE zone. For a seller in Chicago, UTC midnight on the
         * 12th is 19:00 on the 11th - so the edit wrote back the 11th, the next
         * pull parsed the 11th, and the next edit wrote the 10th. `wireBody`
         * serves both insert and edit from one path, so it compounded on every
         * save.
         *
         * iOS settled this in US-1494 and reached the same answer:
         * `ExpenseStore.bucketingCalendar` is a UTC calendar, with a comment
         * saying that parsing AND bucketing have to happen in the same zone.
         * This is that decision, ported - which is what AC2 asks for.
         *
         * Everything touching `spentOn` uses this: entry, display, the wire
         * format, and month bucketing. A device-zone read of any one of them
         * re-opens the drift.
         */
        // US-3000 moved the rule ITSELF to CalendarDateField, because trip_date
        // is the same shape of field and two implementations of "format a date
        // for the wire" is exactly how this bug comes back. The alias stays so
        // every existing caller and every word above still reads true.
        val EXPENSE_ZONE: ZoneId = CalendarDateField.ZONE

        /**
         * `YYYY-MM-DD` for the server's `spent_on` DATE column.
         *
         * Lives here, not on the repository: it is pure date logic, and behind a
         * class that needs a Supabase client it could only be tested with one.
         * Sending a full timestamp instead makes Postgres truncate in UTC, which
         * moves an evening expense to the next day east of Greenwich and to the
         * previous day west of it.
         */
        fun isoDate(epochMs: Long, zone: ZoneId = EXPENSE_ZONE): String = CalendarDateField.iso(epochMs, zone)

        /** The epoch-ms anchor for a calendar date, in [EXPENSE_ZONE]. */
        fun startOfDayMs(date: java.time.LocalDate): Long = CalendarDateField.startOfDayMs(date)

        /**
         * Expense categories, mirroring the iOS `ExpenseTypes` picker.
         *
         * Wire values are snake_case because they are stored verbatim in the
         * server column; the labels are what the picker shows.
         */
        val CATEGORIES: List<Pair<String, String>> = listOf(
            "supplies" to "Supplies",
            "shipping" to "Shipping",
            "software" to "Software",
            "fees" to "Fees",
            "mileage" to "Mileage",
            "sourcing" to "Sourcing",
            "equipment" to "Equipment",
            "other" to "Other",
        )

        fun labelFor(category: String): String = CATEGORIES.firstOrNull { it.first == category }?.second
            // A category the server knows and this build doesn't is shown as
            // itself rather than silently relabeled "Other".
            ?: category.replaceFirstChar { it.uppercase() }

        /** Editing seeds the form from the stored row. */
        fun from(entity: ExpenseEntity): ExpenseDraft = ExpenseDraft(
            id = entity.id,
            category = entity.category,
            // ROUNDED, never truncated: `(0.29 * 100).toLong()` is 28, because
            // 0.29 is really 0.28999999…, so a plain cast would quietly shave a
            // cent off an amount every time the seller opened it to edit.
            amountText = CurrencyAmount.formatRaw(Math.round(entity.amount * 100)),
            description = entity.expenseDescription.orEmpty(),
            spentOnMs = entity.spentOn,
            inventoryItemId = entity.inventoryItemId,
            listingId = entity.listingId,
        )
    }
}
