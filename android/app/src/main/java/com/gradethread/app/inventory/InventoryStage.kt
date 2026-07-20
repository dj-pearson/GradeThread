package com.gradethread.app.inventory

/**
 * US-1342: the inventory stage tabs (iOS `InventoryStage`).
 *
 * NOTE ON THE ACCEPTANCE CRITERIA: US-1342 describes the tabs as
 * "all/draft/listed/sold/unsold". That does not match the iOS surface this
 * story ports. There are SEVEN stages, "listed" is named `ACTIVE`, and there
 * is no "unsold" stage at all. Parity with iOS is the story's stated purpose,
 * so the iOS set is what's implemented here.
 */
enum class InventoryStage(val wire: String, val label: String) {
    ALL("all", "All"),
    TO_LIST("to_list", "To list"),
    DRAFTS("drafts", "Drafts"),
    ACTIVE("active", "Listed"),
    SOLD("sold", "Sold"),
    SHIPPED("shipped", "Shipped"),
    RETURNED("returned", "Returned"),
    ;

    /** The statuses this stage admits. */
    val matchingStatuses: Set<String>
        get() = when (this) {
            ALL -> allKnownStatuses
            TO_LIST -> setOf(
                "sourced", "acquired", "cataloged", "measured",
                "photographed", "graded", "comped",
            )
            DRAFTS -> setOf("drafted")
            ACTIVE -> setOf("listed")
            SOLD -> setOf("sold")
            SHIPPED -> setOf("shipped", "completed")
            RETURNED -> setOf("returned")
        }

    fun matches(status: String): Boolean = status in matchingStatuses

    companion object {
        /**
         * Every status the app knows about — and therefore everything ALL
         * admits, including `archived`/`keeping`/`wearing`, which have no tab
         * of their own.
         */
        val allKnownStatuses: Set<String> = setOf(
            "sourced", "acquired", "cataloged", "measured", "photographed",
            "grading", "graded", "comped", "drafted",
            "listed", "sold", "shipped", "completed", "returned",
            "archived", "keeping", "wearing",
        )

        /** Tab order. */
        val userFacing: List<InventoryStage> = listOf(
            ALL, TO_LIST, DRAFTS, ACTIVE, SOLD, SHIPPED, RETURNED,
        )

        /**
         * Carried over from iOS deliberately: `grading` is a known status and
         * a board column, but belongs to NO user-facing stage except ALL — so
         * an item mid-grading vanishes from every tab but All. Documented
         * here because it looks like a bug when someone hits it.
         */
        val statusesWithoutASpecificTab: Set<String> =
            setOf("grading", "archived", "keeping", "wearing")
    }
}
