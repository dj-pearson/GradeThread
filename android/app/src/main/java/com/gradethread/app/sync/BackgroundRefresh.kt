package com.gradethread.app.sync

import com.gradethread.app.money.Money
import com.gradethread.app.sync.db.InventoryItemEntity
import com.gradethread.app.sync.db.SaleEntity

/**
 * US-1379 (iOS `NewSaleNotifier` / `NewGradeNotifier`): what changed while the
 * app wasn't open.
 *
 * Pure over a stored baseline, because the whole feature runs with nobody
 * watching. A false positive here wakes someone at 3am about a sale they
 * already knew about; a false negative loses the one notification they wanted.
 */
object BackgroundRefresh {

    /**
     * How many notifications one refresh may post.
     *
     * A first sync after a long gap can find dozens of new rows. Posting one
     * per row buries the phone and teaches the seller to swipe the lot away
     * without reading — so past this, they get a single summary instead.
     */
    const val MAX_INDIVIDUAL = 3

    /** The two things worth waking someone for. */
    data class Findings(
        val newSales: List<SaleEntity>,
        val newlyGraded: List<InventoryItemEntity>,
    ) {
        val isEmpty: Boolean get() = newSales.isEmpty() && newlyGraded.isEmpty()
    }

    /**
     * What's new since the baseline.
     *
     * An EMPTY baseline finds nothing, deliberately. The first run after an
     * install or a sign-in has no idea what the seller has already seen, and
     * announcing an entire back catalogue as "new" is the classic version of
     * this bug.
     */
    fun findings(
        sales: List<SaleEntity>,
        items: List<InventoryItemEntity>,
        seenSaleIds: Set<String>,
        seenGradedItemIds: Set<String>,
        baselineEstablished: Boolean,
    ): Findings {
        if (!baselineEstablished) return Findings(emptyList(), emptyList())
        return Findings(
            newSales = sales
                .filter { it.id !in seenSaleIds }
                // A refunded or cancelled order arriving in a pull is not news
                // worth a notification.
                .filter { it.status.isBlank() || it.status == "completed" || it.status == "pending" }
                .sortedByDescending { it.soldAt ?: it.saleDate },
            newlyGraded = items
                .filter { it.gradeValue != null }
                .filter { it.id !in seenGradedItemIds }
                .sortedByDescending { it.updatedAt },
        )
    }

    /** Everything currently known, for the next run's baseline. */
    fun baseline(sales: List<SaleEntity>, items: List<InventoryItemEntity>): Pair<Set<String>, Set<String>> =
        sales.map { it.id }.toSet() to items.filter { it.gradeValue != null }.map { it.id }.toSet()

    // ── Copy ─────────────────────────────────────────────────────────────────

    data class Notice(
        val id: String,
        val title: String,
        val body: String,
        /** The item to open, or null for a summary. */
        val itemId: String?,
    )

    /**
     * The notifications to post.
     *
     * Individually up to [MAX_INDIVIDUAL], then one summary. The threshold is
     * about attention, not volume: three is a glance, ten is a wall.
     */
    fun notices(findings: Findings): List<Notice> {
        if (findings.isEmpty) return emptyList()

        val total = findings.newSales.size + findings.newlyGraded.size
        if (total > MAX_INDIVIDUAL) return listOf(summary(findings))

        return findings.newSales.map { saleNotice(it) } +
            findings.newlyGraded.map { gradeNotice(it) }
    }

    private fun saleNotice(sale: SaleEntity) = Notice(
        // Keyed on the row, so a re-run can't post the same sale twice.
        id = "sale-${sale.id}",
        title = "You made a sale",
        body = buildString {
            append(Money.format(sale.salePrice))
            sale.buyerUsername?.takeIf { it.isNotBlank() }?.let { append(" to $it") }
        },
        itemId = sale.inventoryItemId,
    )

    private fun gradeNotice(item: InventoryItemEntity) = Notice(
        id = "grade-${item.id}",
        title = "Grade ready",
        body = buildString {
            append(item.title.ifBlank { "Your item" })
            item.gradeValue?.let {
                append(" graded ")
                append(String.format(java.util.Locale.US, "%.1f", it))
            }
            item.gradeLabel?.takeIf { it.isNotBlank() }?.let { append(" · $it") }
        },
        itemId = item.id,
    )

    private fun summary(findings: Findings): Notice {
        val parts = buildList {
            findings.newSales.size.takeIf { it > 0 }?.let {
                add("$it ${if (it == 1) "sale" else "sales"}")
            }
            findings.newlyGraded.size.takeIf { it > 0 }?.let {
                add("$it ${if (it == 1) "grade" else "grades"}")
            }
        }
        return Notice(
            // One id for the whole batch, so a later summary replaces this one
            // rather than stacking a second wall on top.
            id = "background-summary",
            title = "While you were away",
            body = parts.joinToString(" and ") + " landed.",
            itemId = null,
        )
    }
}
