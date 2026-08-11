package com.gradethread.app.capture

/**
 * US-2469: the Kotlin mirror of `measurementGroupFor` in
 * src/lib/measurement-templates.ts (and its byte-identical edge copy), matching
 * the iOS `GarmentGroup`.
 *
 * The photo profile for CLOTHING is chosen by garment group, not by
 * `item_category`: the category enum says "clothing" for a t-shirt and for a
 * suit alike, which is how a t-shirt ended up being offered an inseam slot and
 * a blazer was never offered a shoulder. The group comes from the free-text
 * `inventory_items.category` the seller typed.
 *
 * WHY THIS IS DUPLICATED RATHER THAN FETCHED. The profile table is cached for
 * offline use, so the client has to be able to pick a key with no network. The
 * alternative — asking the edge to resolve it per item — would make the capture
 * flow's slot list a network dependency, which is the one thing it cannot be.
 * `GarmentGroupTest` pins the cases that matter against the same expectations
 * the web and iOS suites assert.
 */
enum class GarmentGroup(val wire: String) {
    TOP("top"),
    BOTTOM("bottom"),
    DRESS("dress"),
    OUTERWEAR("outerwear"),
    SUIT("suit"),
    SHOES("shoes"),
    WATCH("watch"),
    BAG("bag"),
    ACCESSORY("accessory"),
    HEADWEAR("headwear"),
    GENERIC("generic"),
    ;

    /**
     * Garment groups that have their own `item_category` photo profile. The
     * measurement groups and the item_category enum are two taxonomies that
     * overlap here; this is the join, mirroring GROUP_TO_CATEGORY on the edge.
     */
    val itemCategoryProfileKey: String?
        get() = when (this) {
            SHOES -> "shoes"
            WATCH -> "watches"
            BAG -> "bags"
            ACCESSORY -> "accessories"
            HEADWEAR -> "headwear"
            else -> null
        }

    /** The profile-table key for this group, e.g. "clothing:suit". */
    val clothingProfileKey: String get() = "clothing:$wire"

    companion object {
        private fun m(pattern: String, s: String): Boolean =
            Regex(pattern, RegexOption.IGNORE_CASE).containsMatchIn(s)

        /**
         * Maps a free-form category/garment string to a group. The branch ORDER
         * is load-bearing and mirrors the TypeScript exactly — bags first
         * because the noun that matters is the last one ("boot bag" is a bag,
         * not a boot).
         */
        fun from(category: String?): GarmentGroup {
            val c = (category ?: "").lowercase()
            if (c.isEmpty()) return GENERIC

            if (m("(bag|purse|tote|clutch|satchel|crossbody|backpack|rucksack|duffel|duffle|handbag|hobo|pouch|wallet|briefcase)", c)) return BAG
            if (m("(hat|cap|beanie|snapback|fitted|trucker|visor|fedora|beret|bucket.?hat|headwear|balaclava)", c)) return HEADWEAR
            if (m("(tie|necktie|bow.?tie|belt|scarf|scarves|glove|mitten|shawl|pocket.?square|cravat|ascot|suspender|accessor)", c)) return ACCESSORY
            if (m("(shoe|sneaker|boot|sandal|footwear|loafer|mule|clog|slipper)", c)) return SHOES
            if (m("watch", c)) return WATCH

            // "dress" is a modifier more often than a noun in resale. Matching
            // the compound and REFUSING the dress branch is what keeps
            // "sundress" and "shirtdress" correct — any reorder that fixed
            // "dress shirt" would have broken those.
            val dressModifier = m(
                "dress\\s*-?\\s*(shirt|blouse|pant|trouser|slack|short|skirt|sock|shoe|boot|belt|tie|watch|coat|jacket|blazer|vest|suit|uniform)",
                c,
            )
            if (!dressModifier &&
                m("(dress|romper|jumpsuit|maxi|mini|midi|swimsuit|bikini|tankini|monokini|one.?piece)", c)
            ) {
                return DRESS
            }

            if (m("(jacket|coat|outerwear|blazer|parka|windbreaker|overcoat|anorak|bomber|vest|gilet|fleece|cardigan|robe|kimono|poncho|cape)", c)) return OUTERWEAR

            // AFTER outerwear so a standalone "suit jacket" stays outerwear, and
            // BEFORE bottom so "pantsuit" is not claimed by the `pant` keyword.
            val notASuitSet = m("(swim|jump|body|cat|snow|wet|rain|play)suit", c)
            val suitSingleBottom = m("(suit|tuxedo|tux)\\s*-?\\s*(pant|trouser|slack|short|skirt)", c)
            if (m("(pant.?suit|suit|tuxedo|\\btux\\b|two.?piece|three.?piece|coverall|overall|scrub|pajama|pyjama)", c) &&
                !notASuitSet && !suitSingleBottom
            ) {
                return SUIT
            }

            if (m("(pant|jean|short|skirt|trouser|chino|jogger|legging|sweatpant|cargo|trunk|slack|bottom)", c)) return BOTTOM
            if (m("(shirt|tee|t-shirt|top|blouse|sweater|hoodie|sweatshirt|tank|polo|jersey|henley|pullover|crewneck|longsleeve|long.sleeve|rugby|button.down|button.up|oxford|flannel|thermal)", c)) return TOP
            return GENERIC
        }
    }
}
