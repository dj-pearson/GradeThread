package com.gradethread.app.inventory

import androidx.annotation.StringRes
import com.gradethread.app.R
import com.gradethread.app.sync.db.InventoryItemEntity

/**
 * US-1342: inventory sort orders (iOS `SortOption`).
 *
 * NOTE ON THE ACCEPTANCE CRITERIA: US-1342 lists "graded-only" among the
 * sorts. It isn't one on iOS — it's a FILTER
 * ([InventoryFilterCriteria.gradedOnly]). "Highest grade" is the sort.
 *
 * US-2976: [wire] is the persisted value and must never change; [label] is a
 * string RESOURCE, because the two are not the same thing and were the same
 * String until now.
 */
enum class SortOption(val wire: String, @StringRes val label: Int) {
    NEWEST("newest", R.string.inventory_sort_newest),
    OLDEST("oldest", R.string.inventory_sort_oldest),
    BEST_ROI("best_roi", R.string.inventory_sort_best_roi),
    HIGHEST_COMP("highest_comp", R.string.inventory_sort_highest_comp),
    HIGHEST_GRADE("highest_grade", R.string.inventory_sort_highest_grade),
    SKU_NATURAL("sku_natural", R.string.inventory_sort_sku),

    // US-3124: who bought the item. The wire values match the web's `?sort=`
    // ids and iOS's raw values, so a shared link and a phone mean one order.
    SOURCED_BY_AZ("sourcer_az", R.string.inventory_sort_sourced_by_az),
    SOURCED_BY_ZA("sourcer_za", R.string.inventory_sort_sourced_by_za),
    ;

    fun comparator(): Comparator<InventoryItemEntity> = when (this) {
        // Explicit id tiebreak on EVERY order. Swift's sort is not stable and
        // Kotlin's is, so ties would silently order differently per platform;
        // pinning them keeps the two clients showing the same list.
        NEWEST -> compareByDescending<InventoryItemEntity> { it.createdAt }.thenBy { it.id }
        OLDEST -> compareBy<InventoryItemEntity> { it.createdAt }.thenBy { it.id }

        BEST_ROI -> Comparator { a, b ->
            val aRoi = roi(a.targetPrice, a.acquiredPrice)
            val bRoi = roi(b.targetPrice, b.acquiredPrice)
            if (aRoi != bRoi) {
                (bRoi ?: MISSING).compareTo(aRoi ?: MISSING)
            } else {
                compareValuesBy(b, a) { it.createdAt }.let { if (it != 0) it else a.id.compareTo(b.id) }
            }
        }

        HIGHEST_COMP -> Comparator { a, b ->
            // targetPrice THEN listingPrice — the opposite precedence from
            // effectivePrice. That inconsistency exists on iOS; replicated
            // deliberately so the same list doesn't sort differently per
            // platform. Worth fixing on both at once, not here.
            val aPrice = a.targetPrice ?: a.listingPrice ?: MISSING
            val bPrice = b.targetPrice ?: b.listingPrice ?: MISSING
            if (aPrice != bPrice) {
                bPrice.compareTo(aPrice)
            } else {
                compareValuesBy(b, a) { it.createdAt }.let { if (it != 0) it else a.id.compareTo(b.id) }
            }
        }

        HIGHEST_GRADE -> Comparator { a, b ->
            val aGrade = a.gradeValue ?: MISSING
            val bGrade = b.gradeValue ?: MISSING
            if (aGrade != bGrade) {
                bGrade.compareTo(aGrade)
            } else {
                compareValuesBy(b, a) { it.createdAt }.let { if (it != 0) it else a.id.compareTo(b.id) }
            }
        }

        SKU_NATURAL -> Comparator { a, b ->
            naturalCompare(a.sku.orEmpty(), b.sku.orEmpty()).let {
                if (it != 0) it else a.id.compareTo(b.id)
            }
        }

        SOURCED_BY_AZ, SOURCED_BY_ZA -> Comparator { a, b ->
            // Nobody recorded sorts LAST in BOTH directions — an item with no
            // sourcer is unknown, not "before A". Same rule as the web's NULLS
            // LAST and iOS's comparator; a blank string counts as nobody.
            val nameA = a.sourcedBy?.trim()?.ifEmpty { null }
            val nameB = b.sourcedBy?.trim()?.ifEmpty { null }
            when {
                nameA == null && nameB == null -> a.id.compareTo(b.id)
                nameA == null -> 1
                nameB == null -> -1
                else -> {
                    val order = naturalCompare(nameA, nameB)
                    val directed = if (this == SOURCED_BY_AZ) order else -order
                    if (directed != 0) {
                        directed
                    } else {
                        // One person's items, newest first, id pinning the tie.
                        compareValuesBy(b, a) { it.createdAt }
                            .let { if (it != 0) it else a.id.compareTo(b.id) }
                    }
                }
            }
        }
    }

    companion object {
        /** Missing values sink to the bottom of every descending sort. */
        private const val MISSING = -Double.MAX_VALUE

        /**
         * @return null unless cost > 0 — a zero-cost item sorts as MISSING
         * rather than as infinite ROI.
         */
        fun roi(target: Double?, cost: Double?): Double? {
            if (target == null || cost == null || cost <= 0.0) return null
            return (target - cost) / cost
        }

        /**
         * Digit runs compare numerically, so SKU-10 sorts after SKU-9 rather
         * than before it.
         */
        fun naturalCompare(lhs: String, rhs: String): Int {
            val a = lhs.lowercase()
            val b = rhs.lowercase()
            var i = 0
            var j = 0
            while (i < a.length && j < b.length) {
                val ca = a[i]
                val cb = b[j]
                if (ca.isDigit() && cb.isDigit()) {
                    var endA = i
                    while (endA < a.length && a[endA].isDigit()) endA++
                    var endB = j
                    while (endB < b.length && b[endB].isDigit()) endB++
                    // An overlong run can't fit a Long; fall back to 0 like iOS
                    // rather than throwing on a pathological SKU.
                    val numA = a.substring(i, endA).toLongOrNull() ?: 0L
                    val numB = b.substring(j, endB).toLongOrNull() ?: 0L
                    if (numA != numB) return numA.compareTo(numB)
                    i = endA
                    j = endB
                } else {
                    if (ca != cb) return ca.compareTo(cb)
                    i++
                    j++
                }
            }
            // Whichever string ran out first sorts first.
            return (a.length - i).compareTo(b.length - j)
        }
    }
}
