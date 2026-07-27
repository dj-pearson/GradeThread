package com.gradethread.app.money

import com.gradethread.app.capture.CurrencyAmount
import com.gradethread.app.sync.db.ExpenseEntity
import java.time.Instant
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
         * Local-date `YYYY-MM-DD` for the server's `spent_on` DATE column.
         *
         * Lives here, not on the repository: it is pure date logic, and behind a
         * class that needs a Supabase client it could only be tested with one.
         * Sending a full timestamp instead makes Postgres truncate in UTC, which
         * moves an evening expense to the next day east of Greenwich and to the
         * previous day west of it.
         */
        fun isoDate(epochMs: Long, zone: ZoneId = ZoneId.systemDefault()): String =
            Instant.ofEpochMilli(epochMs).atZone(zone).toLocalDate().toString()

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

        fun labelFor(category: String): String =
            CATEGORIES.firstOrNull { it.first == category }?.second
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
