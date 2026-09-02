package com.gradethread.app.inventory

import androidx.annotation.StringRes
import com.gradethread.app.R

/**
 * US-1342: the inventory stage tabs (iOS `InventoryStage`).
 *
 * NOTE ON THE ACCEPTANCE CRITERIA: US-1342 describes the tabs as
 * "all/draft/listed/sold/unsold". That does not match the iOS surface this
 * story ports. "listed" is named `ACTIVE`, and there is no "unsold" stage at
 * all. Parity with iOS is the story's stated purpose, so the iOS set is what's
 * implemented here.
 *
 * UNLISTED replaced the separate TO_LIST and DRAFTS stages (2026-09-02, with
 * the web and iOS). They were one job, getting an item live, split at whether
 * a listing row existed yet; the split moved Create draft and Publish onto
 * different tabs. The same split survives as [UnlistedFilter], a chip row
 * inside the one tab.
 *
 * US-2976: [wire] is the persisted tab choice and must not change; [label]
 * is a string RESOURCE. They were both plain Strings, which is how the seven
 * tab names along the top of the inventory stayed English in a Spanish app.
 */
enum class InventoryStage(val wire: String, @StringRes val label: Int) {
    ALL("all", R.string.inventory_stage_all),
    UNLISTED("unlisted", R.string.inventory_stage_unlisted),
    ACTIVE("active", R.string.inventory_stage_active),
    SOLD("sold", R.string.inventory_stage_sold),
    SHIPPED("shipped", R.string.inventory_stage_shipped),
    RETURNED("returned", R.string.inventory_stage_returned),
    ;

    /** The statuses this stage admits. */
    val matchingStatuses: Set<String>
        get() = when (this) {
            ALL -> allKnownStatuses
            UNLISTED -> preDraftStatuses + "drafted"
            ACTIVE -> setOf("listed")
            SOLD -> setOf("sold")
            SHIPPED -> setOf("shipped", "completed")
            RETURNED -> setOf("returned")
        }

    fun matches(status: String): Boolean = status in matchingStatuses

    companion object {
        /**
         * Every status before a draft exists: the UNLISTED rows that still need
         * a listing written. Same set as the web's `TO_LIST_STATUSES`,
         * `grading` included. It used to belong to no stage but ALL, so an
         * item sitting with the grader vanished from every other tab, which
         * looked like data loss.
         */
        val preDraftStatuses: Set<String> = setOf(
            "sourced",
            "acquired",
            "cataloged",
            "measured",
            "photographed",
            "grading",
            "graded",
            "comped",
        )

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
            ALL,
            UNLISTED,
            ACTIVE,
            SOLD,
            SHIPPED,
            RETURNED,
        )

        /**
         * Statuses that belong to NO user-facing stage except ALL. Documented
         * here because it looks like a bug when someone hits it.
         */
        val statusesWithoutASpecificTab: Set<String> =
            setOf("archived", "keeping", "wearing")
    }
}

/**
 * The chip row inside UNLISTED: the old To List / Drafts split, as a filter
 * the seller can see. The web has a fourth chip, Needs review, off the
 * draft's AI review flag; the local cache does not carry that flag, so here
 * every draft is one chip.
 */
enum class UnlistedFilter(@StringRes val label: Int) {
    ALL(R.string.inventory_unlisted_all),
    NEEDS_DRAFT(R.string.inventory_unlisted_needs_draft),
    DRAFTED(R.string.inventory_unlisted_drafted),
    ;

    /** Whether an UNLISTED row passes the chip. Only meaningful for rows the stage admits. */
    fun matches(status: String): Boolean = when (this) {
        ALL -> true
        NEEDS_DRAFT -> status in InventoryStage.preDraftStatuses
        DRAFTED -> status == "drafted"
    }
}
