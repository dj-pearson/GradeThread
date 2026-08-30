package com.gradethread.app.inventory

import androidx.annotation.StringRes
import com.gradethread.app.R

import com.gradethread.app.capture.CurrencyAmount

/**
 * US-1330: the pure duplicate-SKU merge math (iOS `ItemMergePlan`, web
 * `merge-sku-dialog.tsx`). No IO, no Android types — unit-tested directly.
 *
 * The SKU index is PARTIAL and per-user
 * (`idx_inventory_items_user_sku ON (user_id, sku) WHERE sku IS NOT NULL`), so
 * a second item claiming a live SKU dead-ends on a 23505. Rather than surface
 * that as an error, intake offers to combine into the existing row.
 */
object ItemMergePlan {

    /**
     * US-2976: [label] is a string RESOURCE. These are the field names in
     * the merge sheet - the screen that asks a seller which of two values
     * to keep - so reading them is the whole task, and they were English.
     */
    enum class Field(@StringRes val label: Int) {
        TITLE(R.string.merge_field_title),
        BRAND(R.string.merge_field_brand),
        STYLE(R.string.merge_field_style),
        SIZE(R.string.merge_field_size),
        COLOR(R.string.merge_field_color),
        MATERIAL(R.string.merge_field_material),
        CATEGORY(R.string.merge_field_category),
        STATUS(R.string.merge_field_status),
        CONTAINER(R.string.merge_field_container),
        SOURCED_BY(R.string.merge_field_sourced_by),
        ACQUIRED_DATE(R.string.merge_field_acquired_date),
        ACQUIRED_PRICE(R.string.merge_field_acquired_price),
        DESCRIPTION(R.string.merge_field_description),
    }

    /**
     * [normalized] drives conflict detection; [display] is what the sheet
     * shows. They differ for money — `"12"` and `"12.00"` normalize to the
     * same `"1200"` cents so they are NOT reported as a conflict.
     */
    data class Value(val normalized: String, val display: String) {
        val isEmpty: Boolean get() = normalized.isBlank()

        companion object {
            fun text(raw: String?): Value {
                val trimmed = raw?.trim().orEmpty()
                return Value(trimmed.lowercase(), trimmed)
            }

            fun money(raw: String?): Value {
                val cents = CurrencyAmount.parseCents(raw)
                return Value(
                    normalized = cents?.toString().orEmpty(),
                    display = CurrencyAmount.formatDisplay(cents),
                )
            }
        }
    }

    data class Conflict(
        val field: Field,
        val current: Value,
        val existing: Value,
        /**
         * Both sides have a value, so the user is genuinely choosing. When
         * false this is a GAP — the existing row is blank and the form fills
         * it in, which needs no decision.
         */
        val bothFilled: Boolean,
    )

    /** Every field a merge can reconcile, in the order the sheet shows them. */
    fun conflicts(current: Map<Field, Value>, existing: Map<Field, Value>): List<Conflict> =
        Field.entries.mapNotNull { field ->
            val cur = current[field] ?: Value.text(null)
            val ex = existing[field] ?: Value.text(null)
            // Nothing to reconcile if the existing row is blank on a field the
            // form also left blank, or if the two already agree.
            if (ex.isEmpty && cur.isEmpty) return@mapNotNull null
            if (cur.normalized == ex.normalized) return@mapNotNull null
            Conflict(field, cur, ex, bothFilled = !cur.isEmpty && !ex.isEmpty)
        }

    /**
     * The default selection, identical to web: a REAL conflict keeps the value
     * the user just typed (the most recent edit wins); a field the form left
     * blank is filled from the existing record rather than blanked.
     */
    fun defaultKeepExisting(conflicts: List<Conflict>): Set<Field> =
        conflicts.filter { !it.bothFilled && !it.existing.isEmpty }.map { it.field }.toSet()

    /**
     * Is this the SKU unique-index violation? Constraint name first, then the
     * generic 23505/"duplicate key" + "sku" fallback. Never a bare English
     * substring match on the message (US-1004).
     */
    fun isDuplicateSkuError(code: String?, message: String?): Boolean {
        val text = message.orEmpty().lowercase()
        if (text.contains("idx_inventory_items_user_sku")) return true
        val isUnique = code == "23505" || text.contains("duplicate key")
        return isUnique && text.contains("sku")
    }
}
