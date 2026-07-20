package com.gradethread.app.ui.shell

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.gradethread.app.R
import androidx.compose.runtime.LaunchedEffect
import com.gradethread.app.platform.deeplink.DeepLinkController
import com.gradethread.app.platform.rememberHapticFeedback
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1313: the five-section shell. Compact width = bottom NavigationBar;
 * larger widths = NavigationRail (the iPad-split analog). Section switches
 * use the save/restore back-stack pattern so EACH SECTION KEEPS ITS OWN
 * NAVIGATION and stacks never leak across tabs. Add is a one-tap shortcut:
 * it opens the method sheet (Photos / Details / AutoLister) instead of
 * navigating like a plain tab.
 *
 * Shell chrome: a status slot (sync/offline — fed by the sync stories), a
 * reconcile-banner slot, and Search/Tools/Settings entry points. Section
 * changes tick the light haptic (iOS parity).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppShell(
    isCompactWidth: Boolean,
    // Chrome slots the platform stories fill in; empty by default.
    statusBar: @Composable () -> Unit = {},
    reconcileBanner: @Composable () -> Unit = {},
) {
    val navController = rememberNavController()
    val haptics = rememberHapticFeedback()
    var addSheetOpen by remember { mutableStateOf(false) }

    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route

    // US-1314: inbound deep links (push/widget/App Links) drive navigation.
    LaunchedEffect(Unit) {
        DeepLinkController.shared.routes.collect { route ->
            navController.navigate(route.toNavRoute()) { launchSingleTop = true }
        }
    }

    fun selectSection(section: ShellSection) {
        if (section == ShellSection.ADD) {
            haptics.medium()
            addSheetOpen = true
            return
        }
        haptics.light()
        navController.navigate(section.route) {
            // Per-section back stacks (AC2): save the departing section's
            // stack, restore the arriving one, never duplicate the root.
            popUpTo(navController.graph.findStartDestination().id) { saveState = true }
            launchSingleTop = true
            restoreState = true
        }
    }

    val navKind = navKindForWidth(isCompactWidth)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.app_name)) },
                actions = {
                    IconButton(onClick = { navController.navigate(ShellRoutes.SEARCH) }) {
                        Icon(Icons.Outlined.Search, contentDescription = "Search")
                    }
                    IconButton(onClick = { navController.navigate(ShellRoutes.TOOLS) }) {
                        Icon(Icons.Outlined.Build, contentDescription = "Tools")
                    }
                    IconButton(onClick = { navController.navigate(ShellRoutes.SETTINGS) }) {
                        Icon(Icons.Outlined.Settings, contentDescription = "Settings")
                    }
                },
            )
        },
        bottomBar = {
            if (navKind == NavKind.BOTTOM_BAR) {
                NavigationBar {
                    ShellSection.ordered.forEach { section ->
                        NavigationBarItem(
                            selected = currentRoute == section.route,
                            onClick = { selectSection(section) },
                            icon = { Icon(section.icon, contentDescription = null) },
                            label = { Text(section.label) },
                        )
                    }
                }
            }
        },
    ) { innerPadding ->
        Row(Modifier.padding(innerPadding).fillMaxSize()) {
            if (navKind == NavKind.RAIL) {
                NavigationRail {
                    ShellSection.ordered.forEach { section ->
                        NavigationRailItem(
                            selected = currentRoute == section.route,
                            onClick = { selectSection(section) },
                            icon = { Icon(section.icon, contentDescription = null) },
                            label = { Text(section.label) },
                        )
                    }
                }
            }
            androidx.compose.foundation.layout.Column(Modifier.fillMaxSize()) {
                statusBar()
                reconcileBanner()
                ShellNavHost(navController)
            }
        }
    }

    if (addSheetOpen) {
        AddMethodSheet(
            onDismiss = { addSheetOpen = false },
            onPick = { route ->
                addSheetOpen = false
                navController.navigate(route)
            },
        )
    }
}

/** The section graph — placeholder screens until the feature stories land. */
@Composable
private fun ShellNavHost(navController: NavHostController) {
    NavHost(navController = navController, startDestination = ShellSection.HOME.route) {
        composable(ShellSection.HOME.route) { SectionPlaceholder("Home") }
        // Registered for deep links (US-1314 AddItem); the bar's Add button
        // opens the method sheet instead of navigating here.
        composable(ShellSection.ADD.route) { SectionPlaceholder("Add an item") }
        composable(ShellSection.INVENTORY.route) { SectionPlaceholder("Inventory") }
        composable(ShellSection.MONEY.route) { SectionPlaceholder("Money") }
        composable(ShellSection.MARKETPLACES.route) { SectionPlaceholder("Marketplaces") }
        composable(ShellRoutes.SETTINGS) { SectionPlaceholder("Settings") }
        composable(ShellRoutes.SEARCH) { SectionPlaceholder("Search") }
        composable(ShellRoutes.TOOLS) { SectionPlaceholder("Tools") }
        // Capture entry points (the Add sheet's targets).
        composable("capture/photos") { com.gradethread.app.capture.CaptureScreen() }
        composable("capture/details") {
            com.gradethread.app.inventory.DetailsIntakeScreen()
        }
        composable("capture/autolister") { SectionPlaceholder("AutoLister") }
    }
}

/**
 * US-1313 AC2: Add is photo-first — the primary action goes straight to
 * camera capture; Details-first and AutoLister ride the secondary menu.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AddMethodSheet(
    onDismiss: () -> Unit,
    onPick: (String) -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        androidx.compose.foundation.layout.Column(
            Modifier.padding(horizontal = Spacing.md).padding(bottom = Spacing.xl),
        ) {
            BrandPrimaryButton(
                text = "Take photos",
                modifier = Modifier.padding(bottom = Spacing.sm),
            ) { onPick("capture/photos") }
            BrandSecondaryButton(
                text = "Enter details first",
                modifier = Modifier.padding(bottom = Spacing.sm),
            ) { onPick("capture/details") }
            BrandSecondaryButton(text = "AutoLister batch") { onPick("capture/autolister") }
        }
    }
}
