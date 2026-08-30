package com.gradethread.app.importer

import androidx.annotation.StringRes
import com.gradethread.app.R

import com.gradethread.app.capture.FlipdeskCategory
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * US-1389 (iOS `ImportField`, web `src/lib/import-mapping.ts`): the fields a
 * spreadsheet column can map to.
 */
/**
 * US-2976: [label] is a string RESOURCE. These are the column choices in the
 * CSV importer's mapping step, so a seller matching their own spreadsheet to
 * our fields was reading fourteen English words to do it.
 */
enum class ImportField(@StringRes val label: Int) {
    SKIP(R.string.import_field_skip),
    SKU(R.string.import_field_sku),
    TITLE(R.string.import_field_title),
    BRAND(R.string.import_field_brand),
    STYLE(R.string.import_field_style),
    SIZE(R.string.import_field_size),
    COLOR(R.string.import_field_color),
    MATERIAL(R.string.import_field_material),
    CONDITION_NOTES(R.string.import_field_condition_notes),
    CATEGORY(R.string.import_field_category),
    PURCHASE_PRICE(R.string.import_field_purchase_price),
    LIST_PRICE(R.string.import_field_list_price),
    PURCHASE_DATE(R.string.import_field_purchase_date),
    STATUS(R.string.import_field_status),
    ;

    /** Title is the only required field — a row without one cannot be inserted. */
    val isRequired: Boolean get() = this == TITLE

    companion object {
        /**
         * Best guess from a header, at any casing or spacing.
         *
         * An unknown header maps to SKIP rather than to something plausible:
         * silently importing a "Location" column into "Notes" is worse than
         * making the seller point at it themselves.
         */
        fun guess(header: String): ImportField {
            val key = header.lowercase(Locale.US).filter { it.isLetterOrDigit() }
            return TABLE[key] ?: SKIP
        }

        private val TABLE: Map<String, ImportField> = mapOf(
            "item" to SKU, "itemnumber" to SKU, "itemno" to SKU, "sku" to SKU,
            "itemtitle" to TITLE, "title" to TITLE, "name" to TITLE,
            "brand" to BRAND,
            "style" to STYLE, "model" to STYLE,
            "size" to SIZE,
            "color" to COLOR, "colour" to COLOR,
            "material" to MATERIAL, "fabric" to MATERIAL,
            "notes" to CONDITION_NOTES, "note" to CONDITION_NOTES,
            "description" to CONDITION_NOTES, "desc" to CONDITION_NOTES,
            "category" to CATEGORY, "cat" to CATEGORY,
            "purchaseprice" to PURCHASE_PRICE, "cost" to PURCHASE_PRICE,
            "paid" to PURCHASE_PRICE,
            "listprice" to LIST_PRICE, "price" to LIST_PRICE,
            "targetprice" to LIST_PRICE,
            "purchasedate" to PURCHASE_DATE, "purchased" to PURCHASE_DATE,
            "acquired" to PURCHASE_DATE,
            "status" to STATUS,
        )
    }
}

/**
 * US-1389 (iOS `ImportValue`): turning a spreadsheet cell into a stored value.
 *
 * Pure, and the locale handling is the reason. A CSV can come from anywhere,
 * and the naive "strip everything but digits and dots" reading turns
 * "1.299,00" into 1.29900 — a hundred-fold error in a cost basis that then
 * flows into every profit figure the seller looks at (iOS US-1162).
 */
object ImportValue {

    fun price(raw: String?): Double? {
        if (raw == null) return null
        val trimmed = raw.trim()
        // Accounting negatives wrap the WHOLE value in parens. A parenthetical
        // note in a price cell ("$20 (sale)") must not flip the sign.
        val negative = trimmed.startsWith("(") && trimmed.endsWith(")")

        var s = raw.filter { it.isDigit() || it == '.' || it == ',' || it == '-' }
        if (s.isEmpty()) return null

        val lastDot = s.lastIndexOf('.')
        val lastComma = s.lastIndexOf(',')
        if (lastDot >= 0 && lastComma >= 0) {
            // Both present: the RIGHT-MOST is the decimal separator.
            val decimalIsDot = lastDot > lastComma
            s = if (decimalIsDot) {
                s.filter { it != ',' }
            } else {
                s.filter { it != '.' }.replace(',', '.')
            }
        } else if (lastComma >= 0) {
            // Only commas: one comma with 1-2 trailing digits is a decimal
            // ("5,00"); anything else is grouping ("1,299" / "1,000,000").
            val parts = s.split(',')
            s = if (parts.size == 2 && parts[1].length <= 2) {
                s.replace(',', '.')
            } else {
                s.filter { it != ',' }
            }
        }

        val value = s.toDoubleOrNull() ?: return null
        return if (negative) -kotlin.math.abs(value) else value
    }

    /**
     * A free-text status, normalized — or null.
     *
     * Null rather than a guess: an unrecognized status becomes the default
     * ("cataloged"), which is honest, whereas mapping "pending" to "listed"
     * would tell the seller stock is live when it isn't.
     */
    fun status(raw: String?): String? {
        val key = raw?.trim()?.lowercase(Locale.US) ?: return null
        return STATUSES[key]
    }

    fun category(raw: String?): String? {
        val key = raw?.lowercase(Locale.US)?.filter { it.isLetter() } ?: return null
        return CATEGORIES[key]?.wire
    }

    /**
     * A spreadsheet date as `YYYY-MM-DD`.
     *
     * Ambiguous two-digit years and day/month order are the reason the formats
     * are an explicit ordered list: "03/04/2026" is March 4th under the US
     * layouts a US-locale export uses, and guessing per-device locale would
     * make the same file import differently on two phones.
     */
    fun dateIso(raw: String?): String? {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return null
        FORMATS.forEach { pattern ->
            runCatching {
                val parsed = LocalDate.parse(
                    text,
                    DateTimeFormatter.ofPattern(pattern, Locale.US),
                )
                return parsed.format(DateTimeFormatter.ISO_LOCAL_DATE)
            }
        }
        return null
    }

    private val FORMATS = listOf(
        "yyyy-MM-dd",
        "MM/dd/yyyy",
        "M/d/yyyy",
        "MM/dd/yy",
        "M/d/yy",
        "yyyy/MM/dd",
    )

    private val STATUSES = mapOf(
        "sourced" to "sourced", "acquired" to "acquired", "bought" to "acquired",
        "cataloged" to "cataloged", "catalogued" to "cataloged",
        "draft" to "drafted", "drafted" to "drafted",
        "listed" to "listed", "active" to "listed", "live" to "listed",
        "sold" to "sold",
        "shipped" to "shipped",
        "returned" to "returned",
        "keeping" to "keeping", "wearing" to "wearing",
    )

    private val CATEGORIES = mapOf(
        "clothing" to FlipdeskCategory.CLOTHING, "clothes" to FlipdeskCategory.CLOTHING,
        "apparel" to FlipdeskCategory.CLOTHING,
        "shoes" to FlipdeskCategory.SHOES, "sneakers" to FlipdeskCategory.SHOES,
        "footwear" to FlipdeskCategory.SHOES,
        "watches" to FlipdeskCategory.WATCHES, "watch" to FlipdeskCategory.WATCHES,
        "sportscards" to FlipdeskCategory.SPORTS_CARDS,
        "cards" to FlipdeskCategory.SPORTS_CARDS,
        "collectibles" to FlipdeskCategory.COLLECTIBLES,
        "collectible" to FlipdeskCategory.COLLECTIBLES,
        "electronics" to FlipdeskCategory.ELECTRONICS,
        "books" to FlipdeskCategory.BOOKS, "book" to FlipdeskCategory.BOOKS,
        "jewelry" to FlipdeskCategory.JEWELRY, "jewellery" to FlipdeskCategory.JEWELRY,
        "ring" to FlipdeskCategory.JEWELRY, "necklace" to FlipdeskCategory.JEWELRY,
        "earrings" to FlipdeskCategory.JEWELRY, "bracelet" to FlipdeskCategory.JEWELRY,
        "bags" to FlipdeskCategory.BAGS, "bag" to FlipdeskCategory.BAGS,
        "handbag" to FlipdeskCategory.BAGS, "purse" to FlipdeskCategory.BAGS,
        "backpack" to FlipdeskCategory.BAGS, "tote" to FlipdeskCategory.BAGS,
        "accessories" to FlipdeskCategory.ACCESSORIES,
        "accessory" to FlipdeskCategory.ACCESSORIES,
        "hat" to FlipdeskCategory.ACCESSORIES, "cap" to FlipdeskCategory.ACCESSORIES,
        "belt" to FlipdeskCategory.ACCESSORIES, "scarf" to FlipdeskCategory.ACCESSORIES,
        "sunglasses" to FlipdeskCategory.ACCESSORIES,
        "other" to FlipdeskCategory.OTHER,
    )
}
