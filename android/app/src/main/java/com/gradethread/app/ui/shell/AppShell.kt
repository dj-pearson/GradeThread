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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.navArgument
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import com.gradethread.app.billing.PlanStepHost
import com.gradethread.app.ui.state.Restorable
import com.gradethread.app.marketplaces.reconciliation.ReconcileBanner
import com.gradethread.app.sync.PersistenceHealthHost
import com.gradethread.app.sync.SyncStatusHost
import com.gradethread.app.plangate.PlanGateHost
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
    /**
     * US-1356: override the shell-wide orphan banner. Null uses the real one,
     * which reads the count itself and navigates into the queue.
     */
    reconcileBanner: (@Composable () -> Unit)? = null,
) {
    val navController = rememberNavController()
    val haptics = rememberHapticFeedback()
    // US-1390: saveable, not remembered. A rotation with the Add sheet open
    // otherwise closes it mid-choice, and on a foldable that happens every time
    // someone opens the device.
    var addSheetOpen by rememberSaveable(key = Restorable.Keys.ADD_SHEET_OPEN) {
        mutableStateOf(false)
    }

    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route

    // US-1314: inbound deep links (push/widget/App Links) drive navigation.
    LaunchedEffect(Unit) {
        DeepLinkController.shared.routes.collect { route ->
            val target = route.toNavRoute()
            // US-1299: "Add item" is a SHEET, not a destination. The launcher
            // long-press shortcut, its Assistant capability and the public
            // /app/add link all resolve to the ADD route, and navigating there
            // landed every one of them on a placeholder that said the feature
            // was still coming. Three ways in, one dead end.
            if (target == ShellSection.ADD.route) {
                addSheetOpen = true
            } else {
                navController.navigate(target) { launchSingleTop = true }
            }
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
                        Icon(
                            Icons.Outlined.Search,
                            contentDescription = stringResource(R.string.shell_search),
                        )
                    }
                    IconButton(onClick = { navController.navigate(ShellRoutes.TOOLS) }) {
                        Icon(
                            Icons.Outlined.Build,
                            contentDescription = stringResource(R.string.shell_tools),
                        )
                    }
                    IconButton(onClick = { navController.navigate(ShellRoutes.SETTINGS) }) {
                        Icon(
                            Icons.Outlined.Settings,
                            contentDescription = stringResource(R.string.shell_settings),
                        )
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
                // US-1367: a 402 raised by ANY request in ANY tab has to reach
                // the seller, so the gate lives here rather than per-screen.
                // PlanGateNotifier has been publishing since US-1306 with
                // nothing subscribed to it.
                PlanGateHost(onUpgrade = { navController.navigate(ShellRoutes.PAYWALL) })
                // US-2792: same shape and same reason — PersistenceHealth has
                // published noticeNeeded since US-1322 with nothing subscribed,
                // so a Room write failing on a full disk was counted and shown
                // to nobody. Renders nothing until failures are persistent.
                PersistenceHealthHost()
                // US-2792: 119 lines of sync UI that no screen rendered since
                // US-1322. It returns early on IDLE, so it is invisible unless
                // there is queued or stuck work, or the link is down.
                SyncStatusHost()
                if (reconcileBanner != null) {
                    reconcileBanner()
                } else {
                    ReconcileBanner(
                        onOpen = { navController.navigate(ShellRoutes.RECONCILE) },
                    )
                }
                ShellNavHost(navController)
            }
        }
    }

    // US-1367: the one-time post-signup plan step, over everything. It decides
    // for itself whether it should appear and renders nothing otherwise.
    PlanStepHost()

    // US-1384: the first run, ABOVE the plan step — asking someone to pick a
    // plan before they know what the app does is the wrong order. Like the plan
    // step, it decides for itself whether to appear.
    com.gradethread.app.onboarding.OnboardingHost(
        onFirstAction = { route -> navController.navigate(route) { launchSingleTop = true } },
        onConnectEbay = { navController.navigate(ShellSection.MARKETPLACES.route) },
    )

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

/**
 * The section graph.
 *
 * Home / Money / Settings were `SectionPlaceholder`s (deleted in US-2792) until
 * US-1370 / US-1363 /
 * US-1383 landed — the first, third and fifth things a seller could tap. Only
 * `ADD` remains a placeholder; `capture/autolister` became the real batch
 * screen in US-2408.
 */
@Composable
private fun ShellNavHost(navController: NavHostController) {
    /** Switch to a root section, preserving that section's own back stack. */
    fun toSection(section: ShellSection) {
        navController.navigate(section.route) {
            popUpTo(navController.graph.findStartDestination().id) { saveState = true }
            launchSingleTop = true
            restoreState = true
        }
    }

    NavHost(navController = navController, startDestination = ShellSection.HOME.route) {
        // US-1370: the home dashboard replaces the placeholder.
        composable(ShellSection.HOME.route) {
            com.gradethread.app.home.HomeScreen(
                onAddItem = { navController.navigate("capture/photos") },
                onSnap = { navController.navigate(ShellRoutes.SNAP) },
                onOpenInventory = { toSection(ShellSection.INVENTORY) },
                onOpenMoney = { toSection(ShellSection.MONEY) },
                onOpenGrades = { navController.navigate(ShellRoutes.GRADES) },
                onOpenMarketplaces = { toSection(ShellSection.MARKETPLACES) },
                onOpenItem = { itemId -> navController.navigate("item/$itemId") },
            )
        }
        // US-1299: still registered so any route that reaches the NavHost
        // resolves, but it renders NOTHING and pops straight back. "Add" is a
        // choice of method, and there is no screen behind it — the two ways in
        // (the bar button and a deep link) both open the sheet before they get
        // here. What used to be here was a placeholder telling the seller the
        // feature was still coming, which the launcher shortcut and the public
        // /app/add link both walked into.
        composable(ShellSection.ADD.route) {
            LaunchedEffect(Unit) { navController.popBackStack() }
        }
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
        // US-1363/US-1364: the Money dashboard replaces the placeholder.
        composable(ShellSection.MONEY.route) {
            com.gradethread.app.money.MoneyScreen(
                onOpenSales = { navController.navigate(ShellRoutes.SALES) },
                onOpenPayouts = { navController.navigate(ShellRoutes.PAYOUTS) },
            )
        }
        // US-1371: the sales list with per-item P&L.
        composable(ShellRoutes.SALES) {
            com.gradethread.app.money.SalesScreen(
                onOpenItem = { itemId -> navController.navigate("item/$itemId") },
            )
        }
        // US-1368: analytics + the listing-performance drill-down.
        composable(ShellRoutes.ANALYTICS) {
            com.gradethread.app.analytics.AnalyticsScreen(
                onOpenListingPerformance = {
                    navController.navigate(ShellRoutes.LISTING_PERFORMANCE)
                },
                onOpenCommunity = { navController.navigate(ShellRoutes.COMMUNITY) },
                onClose = { navController.popBackStack() },
            )
        }
        // US-1377: the shipping queue.
        composable(ShellRoutes.FULFILLMENT) {
            com.gradethread.app.fulfillment.FulfillmentScreen(
                onOpenItem = { itemId -> navController.navigate("item/$itemId") },
                onClose = { navController.popBackStack() },
            )
        }
        // US-1375: verified-seller status (read-only).
        composable(ShellRoutes.VERIFIED) {
            com.gradethread.app.verified.VerifiedScreen(
                onClose = { navController.popBackStack() },
            )
        }
        // US-1374: ScoutAI + in-store prospecting.
        composable(ShellRoutes.SCOUT) {
            com.gradethread.app.scout.ScoutScreen(
                onOpenProspect = { navController.navigate(ShellRoutes.PROSPECT) },
                onClose = { navController.popBackStack() },
            )
        }
        composable(ShellRoutes.PROSPECT) {
            com.gradethread.app.scout.ProspectScreen(
                onOpenItem = { itemId -> navController.navigate("item/$itemId") },
                onClose = { navController.popBackStack() },
            )
        }
        // US-1373: saved listing presets.
        composable(ShellRoutes.TEMPLATES) {
            com.gradethread.app.templates.TemplatesScreen(
                onClose = { navController.popBackStack() },
            )
        }
        // US-1372: consignors + the payout report.
        composable(ShellRoutes.CONSIGNORS) {
            com.gradethread.app.consignment.ConsignorsScreen(
                onOpenReport = { navController.navigate(ShellRoutes.CONSIGNMENT_REPORT) },
                onClose = { navController.popBackStack() },
            )
        }
        composable(ShellRoutes.CONSIGNMENT_REPORT) {
            com.gradethread.app.consignment.ConsignmentReportScreen(
                onClose = { navController.popBackStack() },
            )
        }
        // US-1369: community benchmarks. A brand tap files a filter request and
        // switches to the inventory TAB, so the seller lands on the real list
        // with its own back stack rather than a one-off copy of it.
        composable(ShellRoutes.COMMUNITY) {
            com.gradethread.app.analytics.CommunityInsightsScreen(
                onOpenInventory = { toSection(ShellSection.INVENTORY) },
                onClose = { navController.popBackStack() },
            )
        }
        composable(ShellRoutes.LISTING_PERFORMANCE) {
            com.gradethread.app.analytics.ListingPerformanceScreen(
                onOpenItem = { itemId -> navController.navigate("item/$itemId") },
                onClose = { navController.popBackStack() },
            )
        }
        // US-1367: plans + credit packs.
        composable(ShellRoutes.PAYWALL) {
            com.gradethread.app.billing.PaywallScreen(
                onClose = { navController.popBackStack() },
            )
        }
        // US-1365: payouts reconciled against the recorded sales.
        composable(ShellRoutes.PAYOUTS) {
            com.gradethread.app.money.PayoutReconciliationScreen(
                onOpenItem = { itemId -> navController.navigate("item/$itemId") },
                onClose = { navController.popBackStack() },
            )
        }
        // US-1350: eBay connections replace the placeholder.
        composable(ShellSection.MARKETPLACES.route) {
            com.gradethread.app.marketplaces.MarketplacesScreen(
                onOpenNegotiation = { navController.navigate(ShellRoutes.negotiation()) },
                onOpenBulkPricing = { navController.navigate(ShellRoutes.BULK_PRICING) },
                onOpenPostSale = { navController.navigate(ShellRoutes.POST_SALE) },
                onOpenRepricing = { navController.navigate(ShellRoutes.REPRICING) },
                onOpenDrafts = { navController.navigate(ShellRoutes.DRAFTS) },
                onOpenAutomations = { navController.navigate(ShellRoutes.AUTOMATIONS) },
            )
        }
        // US-1354: the offers + messages inbox. The item argument is optional —
        // a deep link scopes the inbox to one listing, the tab entry doesn't.
        composable(
            ShellRoutes.NEGOTIATION_PATTERN,
            arguments = listOf(
                navArgument("item") {
                    type = NavType.StringType
                    nullable = true
                    defaultValue = null
                },
            ),
        ) { entry ->
            com.gradethread.app.marketplaces.negotiation.NegotiationInboxScreen(
                filterItemId = entry.arguments?.getString("item"),
                onClose = { navController.popBackStack() },
            )
        }
        // US-1362: automation rules.
        composable(ShellRoutes.AUTOMATIONS) {
            com.gradethread.app.automations.AutomationsScreen(
                onClose = { navController.popBackStack() },
            )
        }
        // US-1359: the AutoLister drafts library.
        composable(ShellRoutes.DRAFTS) {
            com.gradethread.app.autolister.DraftsLibraryScreen(
                onClose = { navController.popBackStack() },
            )
        }
        // US-1358: repricing rules + suggestions.
        composable(ShellRoutes.REPRICING) {
            com.gradethread.app.pricing.RepricingScreen(
                onClose = { navController.popBackStack() },
            )
        }
        // US-1357: post-sale shipping + feedback, fed from the synced sales.
        composable(ShellRoutes.POST_SALE) {
            com.gradethread.app.marketplaces.postsale.PostSaleScreen(
                onClose = { navController.popBackStack() },
                onOpenCases = { navController.navigate(ShellRoutes.EBAY_CASES) },
            )
        }
        // US-1356: the orphan-listing queue.
        composable(ShellRoutes.RECONCILE) {
            com.gradethread.app.marketplaces.reconciliation.ReconciliationScreen(
                onClose = { navController.popBackStack() },
            )
        }
        // US-1355: the bulk price editor.
        composable(ShellRoutes.BULK_PRICING) {
            com.gradethread.app.marketplaces.pricing.BulkPricingScreen(
                onClose = { navController.popBackStack() },
            )
        }
        // US-1383: settings replace the placeholder — including the app's only
        // route to signing out.
        composable(ShellRoutes.SETTINGS) {
            com.gradethread.app.settings.SettingsScreen(
                onOpenMarketplaces = { toSection(ShellSection.MARKETPLACES) },
                // The credit top-up lives in the grading flow; Tools is the
                // stable surface that reaches it without an item in hand.
                onOpenCredits = { navController.navigate(ShellRoutes.PAYWALL) },
                onOpenPlans = { navController.navigate(ShellRoutes.PAYWALL) },
                onOpenSupport = { navController.navigate(ShellRoutes.SUPPORT) },
                onOpenTeam = { navController.navigate(ShellRoutes.TEAM) },
            )
        }
        // US-1349: global search replaces the placeholder.
        // US-2409: the eBay cases with a clock on them.
        composable(ShellRoutes.EBAY_CASES) {
            com.gradethread.app.marketplaces.postsale.EbayCasesScreen(
                onClose = { navController.popBackStack() },
            )
        }
        // US-2495: the personal half of Sourcing Radar.
        composable(ShellRoutes.MY_STORES) {
            com.gradethread.app.radar.MyStoresScreen(
                onClose = { navController.popBackStack() },
            )
        }
        // US-2492: the shared half — what everyone else has found nearby.
        composable(ShellRoutes.RADAR) {
            com.gradethread.app.radar.RadarNearbyScreen(
                onOpenVenue = { id -> navController.navigate(ShellRoutes.radarVenue(id)) },
                onClose = { navController.popBackStack() },
            )
        }
        composable(
            ShellRoutes.RADAR_VENUE_PATTERN,
            arguments = listOf(navArgument("venueId") { type = NavType.StringType }),
        ) { entry ->
            com.gradethread.app.radar.RadarVenueDetailScreen(
                venueId = entry.arguments?.getString("venueId").orEmpty(),
                onClose = { navController.popBackStack() },
            )
        }
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
                onAnalytics = { navController.navigate(ShellRoutes.ANALYTICS) },
                onConsignors = { navController.navigate(ShellRoutes.CONSIGNORS) },
                onTemplates = { navController.navigate(ShellRoutes.TEMPLATES) },
                onScout = { navController.navigate(ShellRoutes.SCOUT) },
                onProspect = { navController.navigate(ShellRoutes.PROSPECT) },
                onVerified = { navController.navigate(ShellRoutes.VERIFIED) },
                onShipping = { navController.navigate(ShellRoutes.FULFILLMENT) },
                onReferrals = { navController.navigate(ShellRoutes.REFERRALS) },
                onSupport = { navController.navigate(ShellRoutes.SUPPORT) },
                onImport = { navController.navigate(ShellRoutes.IMPORT) },
                onMyStores = { navController.navigate(ShellRoutes.MY_STORES) },
                onRadar = { navController.navigate(ShellRoutes.RADAR) },
            )
        }
        // US-1389: CSV / Sheets import.
        composable(ShellRoutes.IMPORT) {
            com.gradethread.app.importer.ImportScreen(
                onDone = {
                    navController.navigate(ShellSection.INVENTORY.route) {
                        popUpTo(ShellRoutes.IMPORT) { inclusive = true }
                    }
                },
            )
        }
        // US-2407: running the workspace from the phone.
        composable(ShellRoutes.TEAM) {
            com.gradethread.app.workspace.TeamScreen(
                onClose = { navController.popBackStack() },
            )
        }
        // US-1386: the support inbox, and the thread a support.reply push
        // deep-links straight to.
        composable(ShellRoutes.SUPPORT) {
            com.gradethread.app.support.SupportScreen(
                onOpenTicket = { id -> navController.navigate(ShellRoutes.supportThread(id)) },
            )
        }
        composable(
            "support/{ticketId}",
            arguments = listOf(navArgument("ticketId") { type = NavType.StringType }),
        ) { entry ->
            com.gradethread.app.support.SupportThreadScreen(
                ticketId = entry.arguments?.getString("ticketId").orEmpty(),
                onBack = { navController.popBackStack() },
            )
        }
        // US-1385: your referral code, and applying a friend's.
        composable(ShellRoutes.REFERRALS) {
            com.gradethread.app.referrals.ReferralsScreen()
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
        // US-2408: the AutoLister batch — no longer a placeholder.
        composable("capture/autolister") {
            com.gradethread.app.autolister.AutolisterSessionScreen(
                onClose = { navController.popBackStack() },
            )
        }
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
                onOpenPassport = { navController.navigate("passport/$itemId") },
                onOpenItem = { newId ->
                    // Replaces this canvas rather than stacking: back from a
                    // duplicate should reach the list, not the item it copied.
                    navController.navigate("item/$newId") {
                        popUpTo("item/{itemId}") { inclusive = true }
                    }
                },
            )
        }
        // US-1376: the item's pedigree timeline.
        composable("passport/{itemId}") { entry ->
            com.gradethread.app.passport.PassportScreen(
                itemId = entry.arguments?.getString("itemId").orEmpty(),
                onClose = { navController.popBackStack() },
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
                text = stringResource(R.string.shell_add_take_photos),
                modifier = Modifier.padding(bottom = Spacing.sm),
            ) { onPick("capture/photos") }
            BrandSecondaryButton(
                text = stringResource(R.string.shell_add_details_first),
                modifier = Modifier.padding(bottom = Spacing.sm),
            ) { onPick("capture/details") }
            BrandSecondaryButton(text = stringResource(R.string.shell_add_autolister)) {
                onPick("capture/autolister")
            }
        }
    }
}
