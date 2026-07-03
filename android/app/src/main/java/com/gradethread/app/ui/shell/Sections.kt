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
