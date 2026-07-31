package com.gradethread.app.marketplaces.publish

/**
 * US-1352: eBay item condition for the publish composer. [wire] is the exact
 * string eBay's Inventory API expects and what the edge stores in
 * `listings.ebay_condition` — mirrors the web composer's dropdown and iOS
 * `EbayCondition`.
 */
enum class EbayCondition(val wire: String, val label: String) {
    NEW("NEW", "New with tags"),

    /**
     * "New without tags" is NEW_OTHER (eBay id 1500), NOT LIKE_NEW (2750):
     * most clothing categories reject 2750, so labelling likeNew as "new
     * without tags" sends an invalid condition (eBay error 25021).
     */
    NEW_OTHER("NEW_OTHER", "New without tags"),
    NEW_WITH_DEFECTS("NEW_WITH_DEFECTS", "New with defects"),
    LIKE_NEW("LIKE_NEW", "Like new"),
    USED_EXCELLENT("USED_EXCELLENT", "Pre-owned – Excellent"),
    USED_VERY_GOOD("USED_VERY_GOOD", "Pre-owned – Very Good"),
    USED_GOOD("USED_GOOD", "Pre-owned – Good"),
    USED_ACCEPTABLE("USED_ACCEPTABLE", "Pre-owned – Acceptable"),
    FOR_PARTS("FOR_PARTS_OR_NOT_WORKING", "For parts / not working"),
    ;

    companion object {
        /**
         * Resolves a stored condition to a case, defaulting to the most common
         * resale condition. Use ONLY where a concrete choice must be made (the
         * composer's initial picker) — for display prefer [displayLabel], which
         * invents nothing.
         */
        fun resolve(raw: String?): EbayCondition =
            entries.firstOrNull { it.wire == raw?.trim() } ?: USED_EXCELLENT

        /**
         * A label for a stored condition with NO invented fallback: a known
         * value maps to its label, an unknown but non-blank value is shown
         * verbatim so a row never misrepresents what is stored, and a blank one
         * returns null (there is nothing to show).
         */
        fun displayLabel(raw: String?): String? {
            val trimmed = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            return entries.firstOrNull { it.wire == trimmed }?.label ?: trimmed
        }
    }
}
