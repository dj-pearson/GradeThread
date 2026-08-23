package com.gradethread.app.ui.shell

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AddCircle
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.List
import androidx.compose.material.icons.outlined.ShoppingCart
import androidx.compose.ui.graphics.vector.ImageVector

/**
 * US-1313: the five-section shell registry (mirrors the iOS tab structure:
 * Home, Inventory, Add, Money, Marketplaces). One place owns routes, labels,
 * and icons so the bottom bar, the rail, and the nav graph can never drift.
 */
enum class ShellSection(
    val route: String,
    val label: String,
    val icon: ImageVector,
) {
    HOME("home", "Home", Icons.Outlined.Home),
    INVENTORY("inventory", "Inventory", Icons.Outlined.List),

    /** The one-tap capture shortcut — visually centered, opens the method
     *  sheet (Photos / Details / AutoLister) rather than a plain tab. */
    ADD("add", "Add", Icons.Filled.AddCircle),
    MONEY("money", "Money", Icons.Outlined.ShoppingCart),
    MARKETPLACES("marketplaces", "Marketplaces", Icons.Outlined.AccountCircle),
    ;

    companion object {
        /** Bar/rail order — Add sits center like iOS. */
        val ordered: List<ShellSection> = listOf(HOME, INVENTORY, ADD, MONEY, MARKETPLACES)
    }
}

/** Non-section shell routes. */
object ShellRoutes {
    const val SETTINGS = "settings"
    const val SEARCH = "search"
    const val TOOLS = "tools"

    /** US-1335: Snap-to-Value, reached from [TOOLS]. */
    const val SNAP = "snap"

    /** US-1341: the certified-grades history, reached from [TOOLS]. */
    const val GRADES = "grades"

    /**
     * US-2815: grade one garment from photos, reached from [TOOLS].
     *
     * Distinct from [GRADES], which lists grades already earned, and from
     * the FlipDesk path, which grades an inventory item whose photos are
     * already uploaded. This one starts from nothing but photos.
     */
    const val CONSUMER_GRADE = "consumer-grade"

    /** US-1371: the sales list, reached from [ShellSection.MONEY]. */
    const val SALES = "sales"

    /** US-1365: payouts against the books, reached from [ShellSection.MONEY]. */
    const val PAYOUTS = "payouts"

    /** US-1367: plans + credit packs, reached from a plan gate or Settings. */
    const val PAYWALL = "paywall"

    /** US-1368: the analytics tab, reached from Tools or Money. */
    const val ANALYTICS = "analytics"

    /** US-1368: the per-listing engagement drill-down, reached from Analytics. */
    const val LISTING_PERFORMANCE = "listing-performance"

    /** US-1369: anonymized community benchmarks, reached from Analytics. */
    const val COMMUNITY = "community"

    /** US-1372: the people you sell for, reached from Tools. */
    const val CONSIGNORS = "consignors"

    /** US-1385: your referral code and a friend's, reached from Tools. */
    const val REFERRALS = "referrals"

    /** US-1389: CSV / Sheets import, reached from Tools. */
    const val IMPORT = "import"

    /** US-2495: which shops actually make money, reached from Tools. */
    const val MY_STORES = "my-stores"

    /** US-2492: the shared half of Sourcing Radar, reached from Tools. */
    const val RADAR = "radar"

    /** The graph pattern for one shop on the shared map. */
    const val RADAR_VENUE_PATTERN = "radar/venue/{venueId}"

    /** US-2492: one shop's aggregate detail, reached from [RADAR]. */
    fun radarVenue(venueId: String) = "radar/venue/$venueId"

    /** US-2407: the workspace's members and invitations, reached from Settings. */
    const val TEAM = "team"

    /** US-1386: the support inbox, reached from Tools or a support.reply push. */
    const val SUPPORT = "support"

    /** US-1386: one support thread. Where a support.reply push lands. */
    fun supportThread(ticketId: String) = "support/$ticketId"

    /** US-1372: what each consignor is owed, reached from Consignors. */
    const val CONSIGNMENT_REPORT = "consignment-report"

    /** US-1373: saved listing presets, reached from Tools. */
    const val TEMPLATES = "templates"

    /** US-1374: ScoutAI deal finder, reached from Tools. */
    const val SCOUT = "scout"

    /** US-1374: in-store prospecting, reached from Scout or Tools. */
    const val PROSPECT = "prospect"

    /** US-1375: verified-seller status, reached from Tools. */
    const val VERIFIED = "verified"

    /** US-1377: the shipping queue, reached from Tools or a mark-shipped push. */
    const val FULFILLMENT = "fulfillment"

    /**
     * US-1354: the offers + messages inbox, reached from Marketplaces or from
     * a `gradethread.com/app/negotiation/<itemId>` deep link.
     */
    const val NEGOTIATION = "negotiation"

    /** The graph pattern — the item filter is optional. */
    const val NEGOTIATION_PATTERN = "$NEGOTIATION?item={item}"

    /** A navigable route, scoped to one listing when [itemId] is given. */
    fun negotiation(itemId: String? = null): String =
        itemId?.takeIf { it.isNotBlank() }?.let { "$NEGOTIATION?item=$it" } ?: NEGOTIATION

    /** US-1355: the bulk price editor, reached from Marketplaces. */
    const val BULK_PRICING = "bulk-pricing"

    /** US-1356: the orphan-listing queue, reached from the shell banner. */
    const val RECONCILE = "reconcile"

    /** US-1357: what still needs posting, and who to thank. */
    const val POST_SALE = "post-sale"

    /** US-2409: eBay returns, cancellations and payment disputes. */
    const val EBAY_CASES = "ebay-cases"

    /** US-1358: repricing rules + the scan's suggestions. */
    const val REPRICING = "repricing"

    /** US-1359: the AutoLister drafts library. */
    const val DRAFTS = "drafts"

    /** US-1362: trigger/action/scope automation rules. */
    const val AUTOMATIONS = "automations"
}

/** Which navigation chrome a window width gets (pure; unit-tested). */
enum class NavKind { BOTTOM_BAR, RAIL }

/**
 * Compact phones keep the thumb-reachable bottom bar; medium/expanded
 * (tablets, unfolded foldables) switch to a rail — the Android analog of the
 * iPad NavigationSplitView behavior.
 */
fun navKindForWidth(isCompactWidth: Boolean): NavKind =
    if (isCompactWidth) NavKind.BOTTOM_BAR else NavKind.RAIL
