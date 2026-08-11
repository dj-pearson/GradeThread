package com.gradethread.app.importer

/**
 * US-1389: a mapped row, ready to become an item.
 *
 * `sheetRow` is 1-BASED and counts the header, so an error message points at
 * the line number the seller can see in their spreadsheet. Off-by-one here is
 * the difference between a useful error and a wild goose chase.
 */
data class ImportDraft(
    val sheetRow: Int,
    val title: String,
    val sku: String? = null,
    val brand: String? = null,
    val style: String? = null,
    val size: String? = null,
    val color: String? = null,
    val material: String? = null,
    val conditionNotes: String? = null,
    val itemCategory: String? = null,
    val status: String? = null,
    val acquiredPrice: Double? = null,
    val targetPrice: Double? = null,
    val acquiredDate: String? = null,
)

/** A row that cannot be imported, and why — reported, never dropped silently. */
data class ImportRejection(val sheetRow: Int, val reason: String)

/** What a commit will do, decided before anything is written. */
data class ImportPlan(
    val ready: List<ImportDraft>,
    val duplicates: List<ImportRejection>,
    val rejected: List<ImportRejection>,
) {
    val total: Int get() = ready.size + duplicates.size + rejected.size
}

/**
 * US-1389: turning a mapped sheet into a plan.
 *
 * Every decision here is pure and made BEFORE anything is written, so the
 * preview the seller approves is exactly what gets committed — not a
 * best-effort re-derivation that could disagree with what they saw.
 */
object Importer {

    const val DEFAULT_STATUS = "cataloged"

    /** How many preview rows are worth showing before it stops being a preview. */
    const val PREVIEW_ROWS = 20

    /** Auto-mapping for a freshly-loaded sheet. */
    fun guessMapping(headers: List<String>): List<ImportField> =
        headers.map(ImportField::guess)

    /**
     * Whether the mapping can be committed at all.
     *
     * Title is the one required field. Without it every row would be rejected,
     * and a Continue button that leads to "0 of 400 imported" is worse than a
     * disabled one that says why.
     */
    fun mappingError(mapping: List<ImportField>): String? =
        if (mapping.none { it == ImportField.TITLE }) {
            "Point one column at \"Item title\" — we can't import a row without it."
        } else {
            null
        }

    /**
     * Build the plan.
     *
     * [existingSkus] is the seller's current inventory. A row whose SKU already
     * exists is SKIPPED, not merged and not duplicated. In-batch collisions are
     * resolved in sheet order, so the first occurrence wins and later ones are
     * reported.
     *
     * **This is NOT what the web import does**, and the comment here claimed it
     * was until US-2410 checked. `src/pages/flipdesk/import.tsx` fills blank
     * columns on the existing row instead of skipping it. Both are defensible;
     * skipping is the one a phone should do, because a fill silently edits rows
     * the seller cannot see on this screen. Recorded rather than quietly
     * matched, so nobody "fixes" one to the other by accident.
     */
    fun plan(
        sheet: CsvParser.Sheet,
        mapping: List<ImportField>,
        existingSkus: Set<String>,
    ): ImportPlan {
        val ready = mutableListOf<ImportDraft>()
        val duplicates = mutableListOf<ImportRejection>()
        val rejected = mutableListOf<ImportRejection>()
        val seen = existingSkus.map { it.trim().lowercase() }.toMutableSet()

        sheet.rows.forEachIndexed { index, cells ->
            // +2: one for the header, one because spreadsheets count from 1.
            val sheetRow = index + 2
            if (cells.all { it.isBlank() }) return@forEachIndexed

            fun value(field: ImportField): String? {
                val column = mapping.indexOfFirst { it == field }
                if (column < 0) return null
                return cells.getOrNull(column)?.trim()?.takeIf { it.isNotEmpty() }
            }

            val title = value(ImportField.TITLE)
            if (title == null) {
                rejected += ImportRejection(sheetRow, "No item title")
                return@forEachIndexed
            }

            val sku = value(ImportField.SKU)
            val skuKey = sku?.lowercase()
            if (skuKey != null && skuKey in seen) {
                duplicates += ImportRejection(sheetRow, "SKU $sku is already in your inventory")
                return@forEachIndexed
            }
            if (skuKey != null) seen += skuKey

            ready += ImportDraft(
                sheetRow = sheetRow,
                title = title,
                sku = sku,
                brand = value(ImportField.BRAND),
                style = value(ImportField.STYLE),
                size = value(ImportField.SIZE),
                color = value(ImportField.COLOR),
                material = value(ImportField.MATERIAL),
                conditionNotes = value(ImportField.CONDITION_NOTES),
                itemCategory = ImportValue.category(value(ImportField.CATEGORY)),
                // An unrecognized status falls back to the default rather than
                // being guessed at — see ImportValue.status.
                status = ImportValue.status(value(ImportField.STATUS)) ?: DEFAULT_STATUS,
                acquiredPrice = ImportValue.price(value(ImportField.PURCHASE_PRICE)),
                targetPrice = ImportValue.price(value(ImportField.LIST_PRICE)),
                acquiredDate = ImportValue.dateIso(value(ImportField.PURCHASE_DATE)),
            )
        }

        return ImportPlan(ready, duplicates, rejected)
    }

    /**
     * The one-line summary shown above the preview.
     *
     * Names what will NOT be imported as loudly as what will. A seller
     * migrating 400 rows needs to know 12 are being skipped before they commit,
     * not after.
     */
    fun summary(plan: ImportPlan): String = buildString {
        append("${plan.ready.size} of ${plan.total} rows ready")
        if (plan.duplicates.isNotEmpty()) {
            append(" · ${plan.duplicates.size} already in your inventory")
        }
        if (plan.rejected.isNotEmpty()) {
            append(" · ${plan.rejected.size} missing a title")
        }
    }

    /**
     * What the seller is told after the commit.
     *
     * [queued] is called out separately from [failed] on purpose: a queued row
     * is going to land, and calling it a failure would send someone off to redo
     * a migration that is already finishing itself.
     */
    fun outcome(inserted: Int, skipped: Int, queued: Int = 0, failed: Int = 0): String =
        buildString {
            append("Imported $inserted ${if (inserted == 1) "item" else "items"}")
            if (queued > 0) append(" · $queued waiting to send when you're back online")
            if (skipped > 0) append(" · $skipped skipped as duplicates")
            if (failed > 0) append(" · $failed couldn't be saved")
            append(".")
        }
}
