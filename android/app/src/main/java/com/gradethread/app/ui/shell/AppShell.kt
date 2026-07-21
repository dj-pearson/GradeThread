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
        // US-1342: the real inventory list replaces the placeholder.
        composable(ShellSection.INVENTORY.route) {
            com.gradethread.app.inventory.InventoryListScreen(
                onGrade = { itemId -> navController.navigate("grade/$itemId") },
                onOpenReport = { itemId -> navController.navigate("report/$itemId") },
                onOpenItem = { itemId -> navController.navigate("item/$itemId") },
                onBulkGrade = { ids ->
                    // Ids ride the route as a comma-joined argument: they are
                    // UUIDs, so a comma can never appear inside one.
                    navController.navigate("grade-bulk/${ids.joinToString(",")}")
                },
            )
        }
        composable(ShellSection.MONEY.route) { SectionPlaceholder("Money") }
        // US-1350: eBay connections replace the placeholder.
        composable(ShellSection.MARKETPLACES.route) {
            com.gradethread.app.marketplaces.MarketplacesScreen()
        }
        composable(ShellRoutes.SETTINGS) { SectionPlaceholder("Settings") }
        // US-1349: global search replaces the placeholder.
        composable(ShellRoutes.SEARCH) {
            com.gradethread.app.inventory.GlobalSearchScreen(
                onOpen = { route ->
                    navController.navigate(route) {
                        // Replaces the search screen: a back-press from the
                        // result should reach where they were, not the query
                        // they have already acted on.
                        popUpTo(ShellRoutes.SEARCH) { inclusive = true }
                    }
                },
            )
        }
        composable(ShellRoutes.TOOLS) {
            ToolsScreen(
                onSnap = { navController.navigate(ShellRoutes.SNAP) },
                onGrades = { navController.navigate(ShellRoutes.GRADES) },
            )
        }
        // US-1335: Snap-to-Value. Both CTAs leave the screen, so it pops
        // itself first — a back-press from the certified-grade flow must not
        // land on a stale result card for a photo already handed off.
        composable(ShellRoutes.SNAP) {
            com.gradethread.app.snap.SnapScreen(
                onCertifiedGrade = {
                    navController.popBackStack()
                    navController.navigate("capture/photos")
                },
                onList = {
                    navController.popBackStack()
                    navController.navigate(ShellSection.INVENTORY.route) {
                        popUpTo(navController.graph.findStartDestination().id) { saveState = true }
                        launchSingleTop = true
                        restoreState = true
                    }
                },
            )
        }
        // Capture entry points (the Add sheet's targets).
        composable("capture/photos") {
            com.gradethread.app.capture.CaptureScreen(
                // US-1334: land on the AI step, replacing the camera in the
                // back stack — a back-press from the review must not drop the
                // seller into a viewfinder for the item they just published.
                onPublished = { itemId ->
                    navController.navigate("ai/extract/$itemId") {
                        popUpTo("capture/photos") { inclusive = true }
                    }
                },
            )
        }
        composable("capture/details") {
            com.gradethread.app.inventory.DetailsIntakeScreen()
        }
        composable("capture/autolister") { SectionPlaceholder("AutoLister") }
        // US-1339: grade a multi-selection.
        composable("grade-bulk/{itemIds}") { entry ->
            val ids = entry.arguments?.getString("itemIds")
                ?.split(",")
                ?.filter { it.isNotBlank() }
                .orEmpty()
            com.gradethread.app.grading.BulkGradeScreen(
                itemIds = ids,
                onClose = { navController.popBackStack() },
            )
        }
        // US-1343: the item canvas.
        composable("item/{itemId}") { entry ->
            val itemId = entry.arguments?.getString("itemId").orEmpty()
            com.gradethread.app.inventory.ItemCanvasScreen(
                itemId = itemId,
                onClose = { navController.popBackStack() },
                onGrade = { navController.navigate("grade/$itemId") },
                onOpenReport = { navController.navigate("report/$itemId") },
                onOpenItem = { newId ->
                    // Replaces this canvas rather than stacking: back from a
                    // duplicate should reach the list, not the item it copied.
                    navController.navigate("item/$newId") {
                        popUpTo("item/{itemId}") { inclusive = true }
                    }
                },
            )
        }
        // US-1341: the certified-grades history.
        composable(ShellRoutes.GRADES) {
            com.gradethread.app.grading.GradesListScreen(
                onOpenReport = { itemId -> navController.navigate("report/$itemId") },
            )
        }
        // US-1337: the stored grade report for an already-graded item.
        composable("report/{itemId}") { entry ->
            com.gradethread.app.grading.GradeReportScreen(
                itemId = entry.arguments?.getString("itemId").orEmpty(),
                onClose = { navController.popBackStack() },
                onDispute = { reportId -> navController.navigate("dispute/$reportId") },
            )
        }
        // US-1340: dispute a certified grade.
        composable("dispute/{gradeReportId}") { entry ->
            com.gradethread.app.grading.DisputeSheet(
                gradeReportId = entry.arguments?.getString("gradeReportId").orEmpty(),
                onClose = { navController.popBackStack() },
            )
        }
        // US-1336: the certified-grade request. A plain destination, not a
        // dialog: the poll can run for two minutes and the phase copy is worth
        // full width.
        composable("grade/{itemId}") { entry ->
            com.gradethread.app.grading.GradeRequestScreen(
                itemId = entry.arguments?.getString("itemId").orEmpty(),
                onClose = { navController.popBackStack() },
                // Replaces the request screen rather than stacking on it — the
                // request is finished, and a back-press from the report should
                // not land on a completed spinner.
                onViewReport = {
                    val itemId = entry.arguments?.getString("itemId").orEmpty()
                    navController.navigate("report/$itemId") {
                        popUpTo("grade/{itemId}") { inclusive = true }
                    }
                },
            )
        }
        // US-1334: the post-capture AI step.
        composable("ai/extract/{itemId}") { entry ->
            val itemId = entry.arguments?.getString("itemId").orEmpty()
            com.gradethread.app.ai.AiExtractScreen(
                itemId = itemId,
                onDone = {
                    navController.navigate(ShellSection.INVENTORY.route) {
                        popUpTo(navController.graph.findStartDestination().id) {
                            saveState = true
                        }
                        launchSingleTop = true
                    }
                },
            )
        }
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
