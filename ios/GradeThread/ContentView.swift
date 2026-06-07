import SwiftData
import SwiftUI
import UIKit

/// Root view. Owns the ``AuthStore`` for the app lifetime and gates the
/// rest of the UI on auth state via ``ProtectedRouteShell``. Also owns the
/// long-lived ``SyncEngine`` + supporting observables (NetworkMonitor +
/// SyncStatusStore) so they keep working across tab switches.
struct ContentView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.photoUploadService) private var photoUploadService

    @State private var authStore = AuthStore()
    @State private var networkMonitor = NetworkMonitor()
    @State private var syncStatus = SyncStatusStore()
    @State private var syncEngine: SyncEngine?
    /// US-198: Supabase Realtime channel for inventory_items. Same
    /// lifecycle as SyncEngine — created on sign-in, paused in
    /// background, torn down on sign-out.
    @State private var realtimeService: RealtimeService?
    /// Last time a foreground sync fired. US-188 60s debounce so rapid
    /// app switches don't hammer the server.
    @State private var lastForegroundPullAt: Date?
    private static let foregroundDebounceSeconds: TimeInterval = 60

    /// First-run welcome carousel. Shown once over everything at launch
    /// (gated by the persisted OnboardingState flag).
    @State private var showingOnboarding = !OnboardingState().hasCompleted

    var body: some View {
        ProtectedRouteShell()
            .environment(authStore)
            .environment(networkMonitor)
            .environment(syncStatus)
            .environment(\.syncEngine, syncEngine)
            .task {
                authStore.start()
                networkMonitor.start()
                startSyncEngineIfNeeded()
                Telemetry.event(TelemetryEvent.appOpen)
            }
            .onChange(of: authStore.phase) { _, newPhase in
                // Boot the sync engine the moment the user signs in;
                // pause it when they sign out so the offline queue doesn't
                // try to push the previous user's mutations.
                switch newPhase {
                case .signedIn(let user):
                    startSyncEngineIfNeeded()
                    startRealtimeIfNeeded(userId: user.id.uuidString)
                case .signedOut:
                    // Reset the delta-sync cursors (US-633) so the next account
                    // does a clean full backfill instead of inheriting this
                    // user's watermark.
                    SyncWatermark().resetAll()
                    Task { await syncEngine?.stop() }
                    syncEngine = nil
                    Task { await realtimeService?.stop() }
                    realtimeService = nil
                    // Cancel any in-flight uploads + wipe the store so
                    // the next user doesn't see ghost progress bars
                    // (US-175 AC).
                    photoUploadService?.cancelAll()
                    // US-190: clear the home-screen widget so it stops
                    // showing the previous user's numbers.
                    WidgetSnapshotPublisher.publishSignedOut()
                case .loading:
                    break
                }
            }
            .onChange(of: scenePhase) { _, newValue in
                if newValue == .active {
                    runForegroundPullIfNeeded()
                    // US-198: re-open the Realtime channel on foreground.
                    if case let .signedIn(user) = authStore.phase {
                        startRealtimeIfNeeded(userId: user.id.uuidString)
                    }
                } else if newValue == .background {
                    // Pause the channel to save battery + data while
                    // the user's away. Re-opens on next .active above.
                    Task { await realtimeService?.pause() }
                }
            }
            .onReceive(
                NotificationCenter.default.publisher(for: .inventoryPullRequested)
            ) { _ in
                // Inventory list pulled-to-refresh — route to the engine.
                Task { await syncEngine?.sync() }
            }
            .onReceive(
                NotificationCenter.default.publisher(for: DeepLinkRouter.notificationName)
            ) { notification in
                guard let route = notification.userInfo?[DeepLinkRouter.routeUserInfoKey]
                        as? DeepLinkRoute else { return }
                handleDeepLink(route)
            }
            .fullScreenCover(isPresented: $showingOnboarding) {
                OnboardingView {
                    OnboardingState().hasCompleted = true
                    showingOnboarding = false
                }
            }
    }

    private func handleDeepLink(_ route: DeepLinkRoute) {
        // We don't own AppRouter directly (it lives inside MainShell).
        // Re-post via a more specific notification so MainShell can
        // mutate its router state without us threading a handle through
        // the env. ProtectedRouteShell is what's currently rendered when
        // .signedIn — anything else gets ignored.
        guard case .signedIn = authStore.phase else { return }
        NotificationCenter.default.post(
            name: .applyDeepLink,
            object: nil,
            userInfo: [DeepLinkRouter.routeUserInfoKey: route]
        )
    }

    private func runForegroundPullIfNeeded() {
        // Skip if we synced within the debounce window. Otherwise tap-
        // tap-tapping between apps triggers a pull on every wake.
        if let last = lastForegroundPullAt,
           Date.now.timeIntervalSince(last) < Self.foregroundDebounceSeconds {
            return
        }
        lastForegroundPullAt = .now
        Task { await syncEngine?.sync() }
    }

    private func startRealtimeIfNeeded(userId: String) {
        // Lazy-init the service the first time we have a sync engine
        // and a signed-in user. Re-entrancy guard inside the service
        // makes start(userId:) safe to call on every foreground.
        guard let engine = syncEngine else { return }
        if realtimeService == nil {
            realtimeService = RealtimeService(syncEngine: engine)
        }
        Task { @MainActor in
            await realtimeService?.start(userId: userId)
            // Mirror the channel status into the existing sync banner
            // so the user sees a 'Reconnecting…' chip without us
            // adding a second status surface.
            if let phase = realtimeService?.phase {
                applyRealtimeStatusToBanner(phase)
            }
        }
    }

    private func applyRealtimeStatusToBanner(_ phase: RealtimeService.Phase) {
        switch phase {
        case .reconnecting:
            syncStatus.set(.reconnecting)
        case .subscribed, .subscribing, .idle, .disabled:
            // Don't override an active sync / pending / offline banner;
            // only switch *into* reconnecting when the channel reports
            // it. The channel re-subscribing flips this back to .idle
            // implicitly through other code paths.
            if syncStatus.phase == .reconnecting {
                syncStatus.set(.idle)
            }
        }
    }

    private func startSyncEngineIfNeeded() {
        guard syncEngine == nil, case .signedIn = authStore.phase else { return }
        let engine = SyncEngine(
            container: modelContext.container,
            statusStore: syncStatus,
            networkMonitor: networkMonitor
        )
        syncEngine = engine
        Task {
            await engine.start()
            await engine.sync()
        }
    }
}

/// Switches between the login surface and the main shell based on the
/// observable auth phase. A `.loading` splash covers the brief window
/// before the SDK emits the initial session event on first launch.
struct ProtectedRouteShell: View {
    @Environment(AuthStore.self) private var authStore

    var body: some View {
        switch authStore.phase {
        case .loading:
            VStack(spacing: 16) {
                ProgressView().tint(Color.brandNavy)
                Text("GradeThread")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(uiColor: .systemBackground))
        case .signedOut:
            LoginView()
        case .signedIn:
            MainShell()
        }
    }
}

// MARK: - Main shell (TabView ↔ NavigationSplitView)

/// The five-section app surface. On compact horizontal width (iPhone, iPad
/// in Slide Over / Split View on the narrow side) it renders as a TabView;
/// at regular width (iPad full-screen) it switches to a NavigationSplitView
/// with a sidebar. The section model is shared so deep links + selection
/// state survive the layout switch.
struct MainShell: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.modelContext) private var modelContext
    @State private var router = AppRouter()

    /// US-189: PhotoIntakeView seeded from a Share Extension batch. Set
    /// when MainShell drains an inbox batch, cleared on dismiss. Using a
    /// fullScreenCover at the shell level so the present survives a
    /// tab switch + lands the user on the same intake surface the Add
    /// sheet would.
    @State private var sharedIntakeBatch: ShareInboxConsumer.DrainedBatch?

    var body: some View {
        // Shadowing-binding pattern: `@State` owns the Observable, then a
        // local `@Bindable` exposes write-bindings to its properties for
        // SwiftUI sheets / popovers.
        @Bindable var router = router
        VStack(spacing: 0) {
            SyncStatusBar()
                .accessibleAnimation(.easeInOut(duration: 0.2), value: router.selection)
            Group {
                if horizontalSizeClass == .regular {
                    SidebarSplitView(router: router)
                } else {
                    TabBarShell(router: router)
                }
            }
        }
        .confirmationDialog(
            "Add an item",
            isPresented: $router.showingAddSheet,
            titleVisibility: .visible
        ) {
            Button("Photo-first (Snap & Catalog)") {
                router.startIntake(.photoFirst)
            }
            Button("Details-first (manual form)") {
                router.startIntake(.detailsFirst)
            }
            Button("AutoLister (batch photos → AI listings)") {
                router.startIntake(.autoLister)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Where would you like to start?")
        }
        .onReceive(
            NotificationCenter.default.publisher(for: .applyDeepLink)
        ) { notification in
            guard let route = notification.userInfo?[DeepLinkRouter.routeUserInfoKey]
                    as? DeepLinkRoute else { return }
            apply(route: route, router: router)
        }
        .task { drainSharedInboxIfNeeded() }
        .onChange(of: scenePhase) { _, newValue in
            if newValue == .active { drainSharedInboxIfNeeded() }
        }
        .fullScreenCover(item: $sharedIntakeBatch) { drained in
            NavigationStack {
                PhotoIntakeView(initialPhotos: drained.slotPhotos)
            }
            .onDisappear {
                ShareInboxConsumer.finish(drained)
                // Tail-recursively drain the next pending batch (if any)
                // so a multi-share session walks the user through each
                // batch one at a time.
                drainSharedInboxIfNeeded()
            }
        }
    }

    /// Pulls the next Share Extension batch off the inbox + presents the
    /// PhotoIntakeView pre-staged with its photos. No-op when nothing's
    /// pending, the user's signed out, or we're mid-present (the
    /// fullScreenCover guard).
    private func drainSharedInboxIfNeeded() {
        guard sharedIntakeBatch == nil else { return }
        guard let drained = ShareInboxConsumer.popNext() else { return }
        // Empty drain (every photo failed to decode) — finish + recurse.
        guard !drained.slotPhotos.isEmpty else {
            ShareInboxConsumer.finish(drained)
            drainSharedInboxIfNeeded()
            return
        }
        Telemetry.event("share_extension_intake_opened")
        sharedIntakeBatch = drained
    }

    /// Translates a DeepLinkRoute into AppRouter mutations. Item-specific
    /// routes resolve the `LocalInventoryItem` from the cache and push its
    /// canvas; if the row hasn't synced yet we fall back to the inventory
    /// list so the tap is never a dead end.
    private func apply(route: DeepLinkRoute, router: AppRouter) {
        switch route {
        case .salesTab:
            router.selection = .sales
        case .marketplacesTab:
            router.selection = .marketplaces
        case let .inventoryItem(id):
            router.selection = .inventory
            // Reset to the list, then push the item's canvas so the tap
            // lands on the report regardless of prior navigation.
            router.inventoryPath = NavigationPath()
            if let item = fetchInventoryItem(id: id) {
                router.inventoryPath.append(item)
            }
        }
    }

    /// One-shot fetch of a cached inventory item by id for deep-link pushes.
    private func fetchInventoryItem(id: String) -> LocalInventoryItem? {
        var descriptor = FetchDescriptor<LocalInventoryItem>(
            predicate: #Predicate { $0.id == id }
        )
        descriptor.fetchLimit = 1
        return try? modelContext.fetch(descriptor).first
    }
}

// MARK: - iPhone / compact layout

private struct TabBarShell: View {
    @Bindable var router: AppRouter

    var body: some View {
        TabView(selection: router.tabSelectionBinding) {
            NavigationStack(path: $router.homePath) {
                DashboardView(router: router)
                    .navigationDestination(for: IntakeRoute.self, destination: intakeDestination)
                    .navigationDestination(for: LocalInventoryItem.self) { item in
                        ItemCanvasView(item: item)
                    }
                    .navigationDestination(for: GradesRoute.self) { _ in
                        GradesListView()
                    }
                    .toolbar {
                        // iPhone has no room for a Settings tab once Home
                        // lands (5-tab limit), so it rides a gear button
                        // here — the standard iOS placement.
                        ToolbarItem(placement: .topBarTrailing) {
                            NavigationLink {
                                SettingsPlaceholder()
                            } label: {
                                Image(systemName: "gear")
                            }
                            .accessibilityLabel("Settings")
                        }
                    }
            }
            .tabItem { Label("Home", systemImage: "house") }
            .tag(AppSection.home)

            NavigationStack(path: $router.inventoryPath) {
                InventoryPlaceholder()
                    .navigationDestination(for: IntakeRoute.self, destination: intakeDestination)
                    .navigationDestination(for: LocalInventoryItem.self) { item in
                        ItemCanvasView(item: item)
                    }
            }
            .tabItem { Label("Inventory", systemImage: "shippingbox") }
            .tag(AppSection.inventory)

            // The Add tab is intercepted in tabSelectionBinding — tapping it
            // shows the confirmation dialog and reverts selection instead of
            // navigating. The placeholder view is never actually rendered.
            Color.clear
                .tabItem {
                    Label("Add", systemImage: "plus.circle.fill")
                }
                .tag(AppSection.add)

            NavigationStack(path: $router.salesPath) {
                MoneyPlaceholder()
                    .navigationDestination(for: IntakeRoute.self, destination: intakeDestination)
            }
            .tabItem { Label("Money", systemImage: "dollarsign.circle") }
            .tag(AppSection.sales)

            NavigationStack(path: $router.marketplacesPath) {
                MarketplacesPlaceholder()
                    .navigationDestination(for: IntakeRoute.self, destination: intakeDestination)
            }
            .tabItem { Label("Marketplaces", systemImage: "antenna.radiowaves.left.and.right") }
            .tag(AppSection.marketplaces)
        }
        .tint(Color.brandNavy)
    }

    @ViewBuilder
    private func intakeDestination(_ route: IntakeRoute) -> some View {
        IntakePlaceholder(route: route)
    }
}

// MARK: - iPad / regular layout

/// Three-column NavigationSplitView for iPad at regular horizontal
/// width. Sidebar carries the section nav; content shows the active
/// section's list; detail hosts a NavigationStack that the content's
/// value-based NavigationLinks push onto.
///
/// SwiftUI's three-column splitter automatically collapses to two
/// columns on iPad portrait + Slide Over — same view, different
/// presentation. iPhone compact width still uses TabBarShell via
/// MainShell.
private struct SidebarSplitView: View {
    @Bindable var router: AppRouter

    var body: some View {
        NavigationSplitView {
            sidebar
        } content: {
            contentColumn
        } detail: {
            detailColumn
        }
    }

    private var sidebar: some View {
        List(selection: router.sidebarSelectionBinding) {
            Section("Workspace") {
                Label("Home", systemImage: "house").tag(AppSection.home)
                Label("Inventory", systemImage: "shippingbox").tag(AppSection.inventory)
                Label("Money", systemImage: "dollarsign.circle").tag(AppSection.sales)
                Label("Marketplaces", systemImage: "antenna.radiowaves.left.and.right").tag(AppSection.marketplaces)
            }
            Section("Account") {
                Label("Settings", systemImage: "gear").tag(AppSection.settings)
            }
        }
        .navigationTitle("GradeThread")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    AppRouter.haptic()
                    router.showingAddSheet = true
                } label: {
                    Label("Add", systemImage: "plus.circle.fill")
                }
            }
        }
    }

    /// Middle column — the list for the active section. Inventory uses
    /// the real list view; the other sections render their own
    /// content. The detail column resolves value-based pushes from
    /// these lists.
    @ViewBuilder
    private var contentColumn: some View {
        switch router.selection {
        case .home:
            DashboardView(router: router)
        case .inventory:
            InventoryListView()
        case .sales:
            MoneyPlaceholder()
        case .marketplaces:
            MarketplacesPlaceholder()
        case .settings:
            SettingsPlaceholder()
        case .add:
            EmptyView()
        }
    }

    /// Right column. Acts as a host for value-based NavigationLink
    /// pushes from the content column — wires up navigationDestination
    /// for the row types we know about (LocalInventoryItem, IntakeRoute).
    /// Empty initial state prompts the user to pick something.
    private var detailColumn: some View {
        NavigationStack(path: detailPathBinding) {
            detailLanding
                .navigationDestination(for: LocalInventoryItem.self) { item in
                    ItemCanvasView(item: item)
                }
                .navigationDestination(for: IntakeRoute.self) { route in
                    IntakePlaceholder(route: route)
                }
                .navigationDestination(for: GradesRoute.self) { _ in
                    GradesListView()
                }
        }
    }

    /// Per-section NavigationPath so deep navigation in the detail
    /// column survives a sidebar switch. Inventory is the canonical
    /// case; others share the same default path.
    private var detailPathBinding: Binding<NavigationPath> {
        switch router.selection {
        case .home:         return $router.homePath
        case .inventory:    return $router.inventoryPath
        case .sales:        return $router.salesPath
        case .marketplaces: return $router.marketplacesPath
        case .settings:     return $router.settingsPath
        case .add:          return $router.inventoryPath
        }
    }

    @ViewBuilder
    private var detailLanding: some View {
        VStack(spacing: 14) {
            Image(systemName: detailLandingIcon)
                .font(.system(size: 56, weight: .light))
                .foregroundStyle(Color.brandNavy)
            Text(detailLandingTitle)
                .font(.title3.weight(.semibold))
            Text(detailLandingSubtitle)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemGroupedBackground))
    }

    private var detailLandingIcon: String {
        switch router.selection {
        case .home:         return "house"
        case .inventory:    return "shippingbox"
        case .sales:        return "dollarsign.circle"
        case .marketplaces: return "antenna.radiowaves.left.and.right"
        case .settings:     return "gear"
        case .add:          return "plus.circle"
        }
    }

    private var detailLandingTitle: String {
        switch router.selection {
        case .home, .inventory: return "Pick an item"
        default:                return "Make a selection"
        }
    }

    private var detailLandingSubtitle: String {
        switch router.selection {
        case .home:         return "Tap an aging item to open its canvas here."
        case .inventory:    return "Tap an item from the list to see its canvas here."
        case .sales:        return "Tap 'See all' to view every sale here."
        case .marketplaces: return "Marketplace setup + sync controls live on the left."
        case .settings:     return "Account + preferences are on the left."
        case .add:          return ""
        }
    }
}

// MARK: - Routing

/// One of the four main sections, plus a pseudo-section for the Add tab.
/// Add is never the resting selection — tapping it triggers the action
/// sheet and the previous selection is restored synchronously.
enum AppSection: Hashable {
    case home, inventory, add, sales, marketplaces, settings
}

/// Intake destinations pushed onto the active tab's NavigationStack after
/// the user picks Photo-first or Details-first from the Add sheet.
enum IntakeRoute: Hashable {
    case photoFirst
    case detailsFirst
    case autoLister
}

/// State and selection logic for the main shell. Holds one `NavigationPath`
/// per tab so deep navigation doesn't leak across tabs (US-171 AC), the
/// resting selection, and the Add-sheet trigger.
@Observable
final class AppRouter {
    var selection: AppSection = .home
    var showingAddSheet = false

    var homePath = NavigationPath()
    var inventoryPath = NavigationPath()
    var salesPath = NavigationPath()
    var marketplacesPath = NavigationPath()
    var settingsPath = NavigationPath()

    /// Binding wrapper used by `TabView(selection:)` that intercepts the
    /// `.add` selection, fires haptic feedback on every real change, and
    /// keeps the resting selection on the previous tab when Add is tapped.
    var tabSelectionBinding: Binding<AppSection> {
        Binding(
            get: { self.selection },
            set: { newValue in
                Self.haptic()
                if newValue == .add {
                    // Don't change `selection`: that snaps the tab bar back
                    // visually after the brief tap state.
                    self.showingAddSheet = true
                    return
                }
                self.selection = newValue
            }
        )
    }

    /// Same idea for the iPad sidebar List(selection:). The selection
    /// binding's value type is Optional because List allows clearing.
    var sidebarSelectionBinding: Binding<AppSection?> {
        Binding(
            get: { self.selection },
            set: { newValue in
                guard let newValue else { return }
                Self.haptic()
                if newValue == .add {
                    self.showingAddSheet = true
                    return
                }
                self.selection = newValue
            }
        )
    }

    /// Appends the picked intake route to whichever tab is currently
    /// active. The view layer handles the actual destination via
    /// `navigationDestination(for: IntakeRoute.self)`.
    func startIntake(_ route: IntakeRoute) {
        switch selection {
        case .home:         homePath.append(route)
        case .inventory:    inventoryPath.append(route)
        case .sales:        salesPath.append(route)
        case .marketplaces: marketplacesPath.append(route)
        case .settings:     settingsPath.append(route)
        case .add:          inventoryPath.append(route) // shouldn't happen
        }
    }

    /// Light-impact haptic on tab change. Kept here as a thin alias so
    /// every existing call site continues to compile; the centralized
    /// implementation now lives in ``HapticFeedback`` (US-195) so
    /// per-action tuning happens in one place.
    static func haptic() {
        Task { @MainActor in HapticFeedback.light() }
    }
}

// MARK: - Tab placeholders

/// Each tab gets a stub until its dedicated story lands. They're real
/// `View`s, not text labels, so the surrounding NavigationStack + toolbar
/// patterns are exercised in CI immediately.
private struct InventoryPlaceholder: View {
    var body: some View {
        InventoryListView()
    }
}

private struct MoneyPlaceholder: View {
    /// US-187: first time the user opens the Money tab, request push
    /// permission. Deliberately deferred from app launch so the prompt
    /// lands at a moment the user's already thinking about sales + money.
    @State private var hasRequestedPermission: Bool = false

    var body: some View {
        MoneyView()
            .task {
                guard !hasRequestedPermission else { return }
                hasRequestedPermission = true
                _ = await PushService.shared.requestPermissionIfNeeded()
            }
    }
}

private struct MarketplacesPlaceholder: View {
    var body: some View {
        MarketplacesView()
    }
}

private struct SettingsPlaceholder: View {
    @Environment(AuthStore.self) private var authStore
    /// Mirrors BackgroundRefreshService.isEnabled — kept in @State so the
    /// toggle binds correctly, written through on change.
    @State private var bgRefreshEnabled: Bool = BackgroundRefreshService().isEnabled
    @State private var showingFeedbackSheet = false
    @State private var showingDeleteAccountSheet = false

    var body: some View {
        List {
            ProfileSection()
            PlanSection()
            Section("Account") {
                if case let .signedIn(user) = authStore.phase {
                    LabeledContent("Email", value: user.email ?? "—")
                }
                Button {
                    showingFeedbackSheet = true
                } label: {
                    Label("Send feedback", systemImage: "envelope")
                }
                Button(role: .destructive) {
                    Task { await authStore.signOut() }
                } label: {
                    Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                }
                Button(role: .destructive) {
                    showingDeleteAccountSheet = true
                } label: {
                    Label("Delete account", systemImage: "trash")
                }
            }
            Section {
                Toggle(isOn: $bgRefreshEnabled) {
                    Label("Refresh in background", systemImage: "arrow.clockwise.icloud")
                }
                .onChange(of: bgRefreshEnabled) { _, newValue in
                    // Persist + schedule (or cancel) the next BG slot.
                    var service = BackgroundRefreshService()
                    service.isEnabled = newValue
                }
            } header: {
                Text("Sync")
            } footer: {
                Text("Pulls listings + sales while the app is in the background, when iOS allows. Respects the system Background App Refresh setting — turning that off in Settings overrides this toggle.")
                    .font(.footnote)
            }
            realtimeSection
            notificationPreferencesSection
            analyticsSection
            DiagnosticsSection()
        }
        .navigationTitle("Settings")
        .sheet(isPresented: $showingFeedbackSheet) {
            FeedbackSheet()
        }
        .sheet(isPresented: $showingDeleteAccountSheet) {
            DeleteAccountSheet()
        }
    }

    /// US-191 analytics opt-in. PostHog events route through
    /// `Telemetry.isAnalyticsEnabled`; flipping this off stops every
    /// product-analytics call. Sentry crash reporting stays on because
    /// crashes are errors, not analytics.
    private var analyticsSection: some View {
        AnalyticsToggleSection()
    }

    /// US-198 Realtime opt-in. Drives RealtimeService.isEnabled.
    private var realtimeSection: some View {
        RealtimeToggleSection()
    }

    /// Per-category toggles for US-187 notifications. Backed by
    /// UserDefaults today so the UX is instant; a follow-up will sync
    /// the values to users.notification_preferences via supabase-swift
    /// so the web reads the same prefs.
    private var notificationPreferencesSection: some View {
        Section {
            ForEach(NotificationCategoryID.allCases, id: \.self) { id in
                NotificationCategoryToggle(category: id)
            }
        } header: {
            Text("Push notifications")
        } footer: {
            Text("First time you open the Sales tab we'll ask permission. Critical alerts (eBay token expiring) can interrupt Focus modes — you control that in iOS Settings → Notifications → GradeThread.")
                .font(.footnote)
        }
    }
}

/// Battery-conscious users can disable the live Postgres-change channel
/// here. UserDefaults-backed, default ON. RealtimeService.isEnabled
/// observes the same key + flips the channel up/down on change.
private struct RealtimeToggleSection: View {
    private static let key = "com.gradethread.app.realtime.enabled"
    @State private var isEnabled: Bool

    init() {
        let initial = UserDefaults.standard.object(forKey: Self.key) as? Bool ?? true
        _isEnabled = State(initialValue: initial)
    }

    var body: some View {
        Section {
            Toggle(isOn: $isEnabled) {
                Label("Live updates", systemImage: "bolt.horizontal")
            }
            .onChange(of: isEnabled) { _, newValue in
                UserDefaults.standard.set(newValue, forKey: Self.key)
            }
        } footer: {
            Text("Streams sale + listing edits as they happen on the server. Turn off to save battery if you prefer pulling-to-refresh.")
                .font(.footnote)
        }
    }
}

/// Analytics opt-in section. Reads + writes Telemetry.isAnalyticsEnabled.
/// Footer is explicit that crashes are still reported — they're errors,
/// not analytics, and users typically expect crash reports to keep
/// flowing even with analytics off.
private struct AnalyticsToggleSection: View {
    @State private var isEnabled: Bool = Telemetry.isAnalyticsEnabled

    var body: some View {
        Section {
            Toggle(isOn: $isEnabled) {
                Label("Share product analytics", systemImage: "chart.bar.xaxis")
            }
            .onChange(of: isEnabled) { _, newValue in
                Telemetry.isAnalyticsEnabled = newValue
            }
        } header: {
            Text("Analytics")
        } footer: {
            Text("Anonymous usage stats help us see which flows work and which need polish. Turning this off stops product analytics; crash reports still go through so we can fix bugs in your build.")
                .font(.footnote)
        }
    }
}

/// One toggle per push category. Persists to UserDefaults under a
/// per-category key so the value survives launches. Default ON.
private struct NotificationCategoryToggle: View {
    let category: NotificationCategoryID
    @State private var isEnabled: Bool

    init(category: NotificationCategoryID) {
        self.category = category
        let key = NotificationCategoryToggle.userDefaultsKey(for: category)
        let initial = UserDefaults.standard.object(forKey: key) as? Bool ?? true
        _isEnabled = State(initialValue: initial)
    }

    var body: some View {
        Toggle(isOn: $isEnabled) {
            VStack(alignment: .leading, spacing: 2) {
                Text(category.label)
                    .font(.subheadline)
                Text(category.helpText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .onChange(of: isEnabled) { _, newValue in
            UserDefaults.standard.set(
                newValue,
                forKey: NotificationCategoryToggle.userDefaultsKey(for: category)
            )
        }
    }

    static func userDefaultsKey(for category: NotificationCategoryID) -> String {
        "com.gradethread.app.notifyPref.\(category.rawValue)"
    }
}

private struct IntakePlaceholder: View {
    let route: IntakeRoute

    var body: some View {
        switch route {
        case .photoFirst:
            PhotoIntakeView()
        case .detailsFirst:
            DetailsIntakeView()
        case .autoLister:
            AutoListerView()
        }
    }
}

// MARK: - Brand colors

extension Color {
    /// Brand palette mirrors the refreshed media kit (design.md §2 / §4A and
    /// the web app's src/index.css). Read from the asset catalog (US-192) so
    /// iOS swaps to the high-contrast variant when Increase Contrast is on in
    /// Accessibility Settings.
    ///
    /// `brandNavy` is the Obsidian Navy (#0C1E36) brand anchor. The Excellent
    /// grade tier (7.0–9.0) uses the distinct Steel Navy (#0F3460) —
    /// `brandSteelNavy` — per design.md §3B, so the anchor and the tier stay
    /// independently tunable.
    static let brandNavy = Color(
        "BrandNavy",
        bundle: nil
    )
    static let brandSteelNavy = Color(
        "BrandSteelNavy",
        bundle: nil
    )
    static let brandRed = Color(
        "BrandRed",
        bundle: nil
    )
    static let brandEmerald = Color(
        "BrandEmerald",
        bundle: nil
    )
    static let brandAmber = Color(
        "BrandAmber",
        bundle: nil
    )
}

#Preview {
    ContentView()
}
