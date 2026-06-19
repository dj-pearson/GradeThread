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
    /// US-984: shared BG-refresh service; we hand it the live SyncEngine below
    /// so the background task can await the real pull instead of a fixed sleep.
    @Environment(\.backgroundRefreshService) private var backgroundRefreshService

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

    /// US-696: optional Face ID / passcode lock. Owned here so it survives
    /// scene-phase transitions; MainShell renders its cover and Settings
    /// toggles it.
    @State private var appLock = AppLock()

    var body: some View {
        ProtectedRouteShell()
            .environment(authStore)
            .environment(networkMonitor)
            .environment(syncStatus)
            .environment(appLock)
            .environment(\.syncEngine, syncEngine)
            .task {
                authStore.start()
                networkMonitor.start()
                startSyncEngineIfNeeded()
                // US-659: drop stale share-extension batches the main app never
                // got around to presenting.
                IntakeInbox.sweepStale()
                // US-694: clear any financial/account exports an interrupted
                // share sheet left behind in the protected Exports/ dir.
                SecureTempFile.sweep()
                Telemetry.event(TelemetryEvent.appOpen)
            }
            // US-661: complete auth handshakes delivered as a Universal Link
            // (password-reset / magic-link email opened from Mail lands on
            // https://gradethread.com/app/auth-callback) or the legacy custom
            // scheme. The in-app ASWebAuthenticationSession captures its own
            // callback, so these only fire for links opened OUTSIDE the app.
            .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                guard let url = activity.webpageURL else { return }
                Task { await authStore.handleAuthCallback(url: url) }
            }
            .onOpenURL { url in
                Task { await authStore.handleAuthCallback(url: url) }
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
                    // Wipe the local SwiftData mirror + offline mutation queue so
                    // the next account can't SEE (dashboard / Money tab) or
                    // FLUSH the previous user's inventory, sales, and listings.
                    // Without this the prior user's numbers persist until a sync
                    // overwrites them — a data-isolation leak.
                    clearAllLocalDataOnSignOut()
                    // US-659: wipe the App Group intake inbox + the persisted
                    // APNs token so the next user can't inherit staged photos
                    // or this device's push registration.
                    IntakeInbox.removeAll()
                    // US-694: wipe any lingering financial/account exports so
                    // the next user can't read the previous user's exports.
                    SecureTempFile.sweep()
                    PushService.shared.clearTokenOnSignOut()
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
            // US-670: when the active workspace changes, re-scope the cache —
            // reset the delta cursors, wipe the previous tenant's local rows,
            // and re-pull the new workspace's data (scoped in pullRemote).
            .onReceive(NotificationCenter.default.publisher(for: .workspaceDidChange)) { _ in
                SyncWatermark().resetAll()
                clearLocalTenantCache()
                Task { await syncEngine?.sync() }
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
                    // US-696: re-arm the app lock so re-entry requires auth.
                    appLock.lockIfEnabled()
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
                // US-747: persist completion + the chosen use case, and queue the
                // first-action routing (MainShell performs it).
                OnboardingView { useCase in
                    OnboardingState().complete(useCase: useCase)
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

    /// US-670: wipe the local mirror so a workspace switch doesn't show the
    /// previous tenant's rows until the re-scoped pull lands. Deletes every
    /// synced tenant model; the next sync repopulates from the active workspace.
    private func clearLocalTenantCache() {
        let ctx = modelContext
        do {
            try ctx.delete(model: LocalInventoryItem.self)
            try ctx.delete(model: LocalItemPhoto.self)
            try ctx.delete(model: LocalListing.self)
            try ctx.delete(model: LocalSale.self)
            try ctx.delete(model: LocalSource.self)
            try ctx.save()
        } catch {
            // Best-effort — the scoped pull still corrects the view on success.
        }
    }

    /// Full local wipe on sign-out: every synced tenant model PLUS the offline
    /// mutation queue, so the next account can neither see nor accidentally
    /// flush the previous user's data. (Workspace switches use
    /// ``clearLocalTenantCache`` instead, which deliberately keeps the queue
    /// since it's the same owner across their own workspaces.)
    private func clearAllLocalDataOnSignOut() {
        let ctx = modelContext
        do {
            try ctx.delete(model: LocalInventoryItem.self)
            try ctx.delete(model: LocalItemPhoto.self)
            try ctx.delete(model: LocalListing.self)
            try ctx.delete(model: LocalSale.self)
            try ctx.delete(model: LocalSource.self)
            try ctx.delete(model: LocalPendingMutation.self)
            try ctx.save()
        } catch {
            // Best-effort — watermarks are reset too, so the next sign-in
            // re-pulls a clean, correctly-scoped backfill regardless.
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
        // US-984: hand the BG-refresh task a handle so it can await the real
        // pull directly. Held weakly there, so dropping `syncEngine` on
        // sign-out lets it fall back to a cold-launch engine next run.
        backgroundRefreshService?.attachSyncEngine(engine)
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
                    .font(.brandTitle2)
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
    @Environment(AppLock.self) private var appLock
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
        // US-747: drop a freshly-onboarded user on their use case's first action.
        // The notification handles the common case (shell already mounted under
        // the onboarding cover); the appear-pass below covers a user who finished
        // onboarding before signing in (no shell mounted to receive the post).
        .onReceive(
            NotificationCenter.default.publisher(for: .onboardingDidFinish)
        ) { _ in
            consumeOnboardingFirstAction(router: router)
        }
        .onAppear { consumeOnboardingFirstAction(router: router) }
        // US-663: cover sensitive financial figures (Dashboard/Money/widget-
        // backed views all live under this shell) in the App Switcher snapshot
        // and while the app is inactive, so payout/sales numbers aren't exposed.
        // US-696: when the app lock is engaged, show the unlock cover instead —
        // it stays up until biometric/passcode auth succeeds.
        .overlay {
            if appLock.state == .locked {
                AppLockCoverView { Task { await appLock.authenticate() } }
                    .transition(.opacity)
            } else if scenePhase != .active {
                PrivacyCoverView()
                    .transition(.opacity)
            }
        }
        .task {
            drainSharedInboxIfNeeded()
            // US-696: cold-launch / first-render unlock prompt.
            if appLock.state == .locked { await appLock.authenticate() }
        }
        .onChange(of: scenePhase) { _, newValue in
            if newValue == .active {
                drainSharedInboxIfNeeded()
                // US-696: prompt to unlock when returning to the foreground.
                if appLock.state == .locked { Task { await appLock.authenticate() } }
            }
        }
        // US-678: global search sheet, reachable from the Home toolbar.
        .sheet(isPresented: $router.showingGlobalSearch) {
            GlobalSearchView()
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
    /// US-747: perform the one-shot, use-case-driven first-action routing queued
    /// by onboarding. Idempotent — the pending flag is cleared the first time it
    /// runs, so the notification + appear paths can both fire safely.
    private func consumeOnboardingFirstAction(router: AppRouter) {
        let state = OnboardingState()
        guard state.pendingFirstAction, let useCase = state.selectedUseCase else { return }
        state.pendingFirstAction = false
        let action = useCase.firstAction
        router.selection = action.section
        if let intake = action.intake {
            router.startIntake(intake)
        }
    }

    private func apply(route: DeepLinkRoute, router: AppRouter) {
        switch route {
        case .salesTab:
            router.selection = .sales
        case .marketplacesTab:
            router.selection = .marketplaces
        case .inventoryTab:
            router.selection = .inventory
            router.inventoryPath = NavigationPath()
        case let .inventoryItem(id):
            router.selection = .inventory
            // Reset to the list, then push the item's canvas so the tap
            // lands on the report regardless of prior navigation.
            router.inventoryPath = NavigationPath()
            if let item = fetchInventoryItem(id: id) {
                router.inventoryPath.append(item)
            }
        case let .negotiationInbox(filterItemId):
            // Offers/messages push → open the inbox under Marketplaces, filtered
            // to the item when one was referenced (US-999).
            router.selection = .marketplaces
            router.marketplacesPath = NavigationPath()
            router.marketplacesPath.append(NegotiationRoute(filterItemId: filterItemId))
        case .gradesList:
            // Grade-ready push with no item id → the Grades list lives off Home.
            router.selection = .home
            router.homePath = NavigationPath()
            router.homePath.append(GradesRoute())
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
                        // US-649: secondary "choose a different add method" menu
                        // — the Add tab itself is the one-tap photo-first path.
                        ToolbarItem(placement: .topBarLeading) {
                            AddMethodMenu(router: router)
                        }
                        // US-678: global search across inventory/listings/sales/sources.
                        ToolbarItem(placement: .topBarTrailing) {
                            Button {
                                router.showingGlobalSearch = true
                            } label: {
                                Image(systemName: "magnifyingglass")
                            }
                            .accessibilityLabel("Search everything")
                        }
                        // iPhone has no room for a Settings tab once Home
                        // lands (5-tab limit), so it rides a gear button
                        // here — the standard iOS placement.
                        ToolbarItem(placement: .topBarTrailing) {
                            NavigationLink {
                                SettingsView()
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
                    // US-684: AutoLister/Details reachable from this tab too.
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            AddMethodMenu(router: router)
                        }
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
                    // US-684: add-method menu reachable from the Money tab.
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            AddMethodMenu(router: router)
                        }
                    }
            }
            .tabItem { Label("Money", systemImage: "dollarsign.circle") }
            .tag(AppSection.sales)

            NavigationStack(path: $router.marketplacesPath) {
                MarketplacesPlaceholder()
                    .navigationDestination(for: IntakeRoute.self, destination: intakeDestination)
                    .navigationDestination(for: NegotiationRoute.self) { route in
                        NegotiationInboxView(filterItemId: route.filterItemId)
                    }
                    // US-684: add-method menu reachable from the Marketplaces tab.
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            AddMethodMenu(router: router)
                        }
                    }
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
                // US-649: iPad has room for the explicit method menu in the
                // sidebar toolbar (default = photo-first on a plain tap).
                AddMethodMenu(router: router, primaryLabel: "Add")
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
            SettingsView()
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
                .navigationDestination(for: NegotiationRoute.self) { route in
                    NegotiationInboxView(filterItemId: route.filterItemId)
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
                .font(.brandTitle2)
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
    /// US-678: presents the global search sheet.
    var showingGlobalSearch = false

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
                    // US-649: the Add tab is now a one-tap shortcut straight
                    // into the photo-first capture flow — the most frequent
                    // action — instead of a mandatory 3-way mode dialog. The
                    // other modes live in the Home toolbar "Add" menu + the
                    // iPad sidebar Add menu. Don't change `selection`: that
                    // snaps the tab bar back after the brief tap state.
                    self.startIntake(.photoFirst)
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

// MARK: - Add-method menu (US-649)

/// Secondary "choose how to add" control. The Add *tab* is a one-tap shortcut
/// into photo-first capture; this menu (Home toolbar + iPad sidebar) exposes the
/// less-frequent Details + AutoLister paths in plain language.
private struct AddMethodMenu: View {
    let router: AppRouter
    var primaryLabel: String? = nil

    var body: some View {
        Menu {
            Button {
                AppRouter.haptic()
                router.startIntake(.photoFirst)
            } label: { Label("Take photos", systemImage: "camera") }
            Button {
                AppRouter.haptic()
                router.startIntake(.detailsFirst)
            } label: { Label("Type details", systemImage: "square.and.pencil") }
            Button {
                AppRouter.haptic()
                router.startIntake(.autoLister)
            } label: { Label("Bulk list with AI", systemImage: "wand.and.stars") }
        } label: {
            if let primaryLabel {
                Label(primaryLabel, systemImage: "plus.circle.fill")
            } else {
                Image(systemName: "plus.circle")
                    .accessibilityLabel("Add an item")
            }
        }
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

/// US-648: structured Settings screen (was the flat `SettingsPlaceholder`).
/// Grouped into Account · Connections · Preferences · Notifications · Support ·
/// About, with the destructive Delete Account isolated in its own footer section
/// well away from Sign Out so it can't be mis-tapped.
struct SettingsView: View {
    @Environment(AuthStore.self) private var authStore
    /// Mirrors BackgroundRefreshService.isEnabled — kept in @State so the
    /// toggle binds correctly, written through on change.
    @State private var bgRefreshEnabled: Bool = BackgroundRefreshService().isEnabled
    @State private var showingFeedbackSheet = false
    @State private var showingDeleteAccountSheet = false
    @State private var showingHelp = false
    @State private var showingImport = false   // US-667 CSV / Sheets import
    // US-648 preferences
    @State private var measurementUnit: MeasurementUnit = AppPreferences.measurementUnit
    @State private var currencyCode: String = AppPreferences.currencyCode ?? "device"
    // US-670: active workspace context (switcher).
    @State private var workspaceContext: WorkspaceContext?

    private static let helpURL = URL(string: "https://gradethread.com/help")!

    var body: some View {
        List {
            // ── Account ──────────────────────────────────────────────
            ProfileSection()
            workspaceSection
            PlanSection()
            // US-194: AI Item Assistant (toggle + monthly usage meter + cap),
            // wired to the users row — mirrors US-167 on the web.
            AIAssistantSection()
            Section("Account") {
                if case let .signedIn(user) = authStore.phase {
                    LabeledContent("Email", value: user.email ?? "—")
                }
                Button(role: .destructive) {
                    Task { await authStore.signOut() }
                } label: {
                    Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }

            // ── Connections ──────────────────────────────────────────
            Section {
                NavigationLink {
                    MarketplacesView()
                } label: {
                    Label("Marketplaces & eBay", systemImage: "antenna.radiowaves.left.and.right")
                }
            } header: {
                Text("Connections")
            } footer: {
                Text("Connect or reconnect your eBay account and review sync status.")
                    .font(.footnote)
            }

            // ── Data ─────────────────────────────────────────────────
            Section {
                Button {
                    showingImport = true
                } label: {
                    Label("Import inventory (CSV / Sheets)", systemImage: "square.and.arrow.down")
                }
                // US-674: reusable listing presets, selectable in Publish + AutoLister.
                NavigationLink {
                    TemplatesView()
                } label: {
                    Label("Listing templates", systemImage: "doc.on.doc")
                }
                // US-676: consignors + per-consignor payout report.
                NavigationLink {
                    ConsignorsView()
                } label: {
                    Label("Consignors", systemImage: "person.2.badge.gearshape")
                }
            } header: {
                Text("Data")
            } footer: {
                Text("Bring an existing catalog in from a CSV file or a shared Google Sheet, save listing templates to reuse description, condition, and policies, or manage consignors and their payout splits.")
                    .font(.footnote)
            }

            // ── Preferences ──────────────────────────────────────────
            preferencesSection
            // These each render their own Section, so they sit at the top level
            // of the List rather than nested inside another Section.
            realtimeSection
            // US-696: optional Face ID / passcode app lock.
            AppLockToggleSection()
            analyticsSection

            // ── Notifications ────────────────────────────────────────
            notificationPreferencesSection

            // ── Support ──────────────────────────────────────────────
            Section("Support") {
                Button {
                    showingFeedbackSheet = true
                } label: {
                    Label("Send feedback", systemImage: "envelope")
                }
                Button {
                    showingHelp = true
                } label: {
                    Label("Help & FAQ", systemImage: "questionmark.circle")
                }
            }
            // DiagnosticsSection renders its own Section — keep it top-level.
            DiagnosticsSection()

            // ── About ────────────────────────────────────────────────
            Section("About") {
                LabeledContent("Version", value: Self.versionString)
            }

            // ── Danger zone (isolated) ───────────────────────────────
            Section {
                Button(role: .destructive) {
                    showingDeleteAccountSheet = true
                } label: {
                    Label("Delete account", systemImage: "trash")
                }
            } footer: {
                Text("Permanently deletes your account and all associated data. This can't be undone.")
                    .font(.footnote)
            }
        }
        .navigationTitle("Settings")
        .sheet(isPresented: $showingFeedbackSheet) {
            FeedbackSheet()
        }
        .sheet(isPresented: $showingDeleteAccountSheet) {
            DeleteAccountSheet()
        }
        .sheet(isPresented: $showingHelp) {
            SafariView(url: Self.helpURL).ignoresSafeArea()
        }
        .sheet(isPresented: $showingImport) {
            CSVImportView()
        }
        .task {
            if workspaceContext == nil, case let .signedIn(user) = authStore.phase {
                let ctx = WorkspaceContext(selfUserId: user.id.uuidString)
                workspaceContext = ctx
                await ctx.load()
            }
        }
    }

    // US-670: workspace switcher + member list. Only shown once the user belongs
    // to a workspace beyond their own (otherwise there's nothing to switch to).
    @ViewBuilder
    private var workspaceSection: some View {
        if let ctx = workspaceContext, ctx.hasMultipleWorkspaces {
            Section {
                Picker("Active workspace", selection: Binding(
                    get: { ctx.activeOwnerId },
                    set: { ctx.switchTo(ownerId: $0) }
                )) {
                    ForEach(ctx.workspaces) { ws in
                        Text(ws.name).tag(ws.ownerId)
                    }
                }
                NavigationLink {
                    TeamView(ownerId: ctx.activeOwnerId)
                } label: {
                    Label("Members", systemImage: "person.2")
                }
            } header: {
                Text("Workspace")
            } footer: {
                Text("Switch which workspace you're working in. Inventory, sales, and listings are scoped to the active workspace.")
                    .font(.footnote)
            }
        }
    }

    /// US-648 Preferences — units + currency (no longer hardcoded), plus the
    /// existing sync / realtime / analytics toggles.
    private var preferencesSection: some View {
        Section {
            Picker(selection: $measurementUnit) {
                ForEach(MeasurementUnit.allCases) { unit in
                    Text(unit.label).tag(unit)
                }
            } label: {
                Label("Measurement units", systemImage: "ruler")
            }
            .onChange(of: measurementUnit) { _, newValue in
                AppPreferences.measurementUnit = newValue
            }

            Picker(selection: $currencyCode) {
                Text("Device default").tag("device")
                ForEach(AppPreferences.currencyOptions, id: \.self) { code in
                    Text(code).tag(code)
                }
            } label: {
                Label("Currency", systemImage: "dollarsign.circle")
            }
            .onChange(of: currencyCode) { _, newValue in
                AppPreferences.currencyCode = (newValue == "device") ? nil : newValue
            }

            Toggle(isOn: $bgRefreshEnabled) {
                Label("Refresh in background", systemImage: "arrow.clockwise.icloud")
            }
            .onChange(of: bgRefreshEnabled) { _, newValue in
                var service = BackgroundRefreshService()
                service.isEnabled = newValue
            }
        } header: {
            Text("Preferences")
        } footer: {
            Text("Background refresh pulls listings + sales when iOS allows; it respects the system Background App Refresh setting. Currency affects how prices are displayed.")
                .font(.footnote)
        }
    }

    private static var versionString: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "—"
        let build = info?["CFBundleVersion"] as? String ?? "—"
        return "\(version) (\(build))"
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

/// US-696 / US-1016: opt-in app lock. Toggling on takes effect on the next time
/// the app is backgrounded + reopened; the device must have biometrics or a
/// passcode configured (the toggle is disabled otherwise so we don't strand the
/// user). The optional biometrics-only sub-toggle switches the policy from
/// `.deviceOwnerAuthentication` (passcode satisfies the lock) to
/// `.deviceOwnerAuthenticationWithBiometrics` (Face ID / Touch ID only).
private struct AppLockToggleSection: View {
    @Environment(AppLock.self) private var appLock
    @State private var isEnabled = false
    @State private var biometricsOnly = false

    var body: some View {
        Section {
            Toggle(isOn: $isEnabled) {
                Label("Require Face ID / passcode", systemImage: "faceid")
            }
            .disabled(!appLock.isAvailable)
            .onChange(of: isEnabled) { _, newValue in
                appLock.isEnabled = newValue
            }

            // Only offer the stricter biometrics-only policy when the lock is on
            // and the device actually has enrolled biometrics to fall back on.
            if isEnabled && appLock.biometricsAvailable {
                Toggle(isOn: $biometricsOnly) {
                    Label("Biometrics only (no passcode)", systemImage: "faceid")
                }
                .onChange(of: biometricsOnly) { _, newValue in
                    appLock.biometricsOnly = newValue
                }
            }
        } header: {
            Text("Security")
        } footer: {
            Text(footerText)
                .font(.footnote)
        }
        .onAppear {
            isEnabled = appLock.isEnabled
            biometricsOnly = appLock.biometricsOnly
        }
    }

    private var footerText: String {
        guard appLock.isAvailable else {
            return "Set up Face ID, Touch ID, or a passcode in iOS Settings to enable an app lock."
        }
        if isEnabled && appLock.biometricsAvailable && biometricsOnly {
            // Lockout warning: biometrics can lock out after repeated failures.
            return "Biometrics only: GradeThread will require Face ID or Touch ID — your device passcode will not unlock it. After several failed attempts iOS locks out biometrics; if that happens you'll be asked for your passcode so you're never locked out."
        }
        return "Require Face ID, Touch ID, or your device passcode each time you reopen GradeThread. Your passcode always satisfies the lock, so you can't be locked out. Protects your sales, payouts, and account if someone gets your unlocked phone."
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

// MARK: - Privacy cover (US-663)

/// Brand-colored cover shown over the app while it's inactive/backgrounded so
/// the App Switcher thumbnail never leaks payout/sales figures.
private struct PrivacyCoverView: View {
    var body: some View {
        ZStack {
            Color.brandNavy.ignoresSafeArea()
            VStack(spacing: 12) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 40, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.9))
                Text("GradeThread")
                    .font(.brandHeadline)
                    .foregroundStyle(.white.opacity(0.9))
            }
        }
    }
}

// MARK: - App lock cover (US-696)

/// Shown over the shell while the optional app lock is engaged. Identical
/// chrome to the privacy cover plus an Unlock button so the user can re-trigger
/// authentication if the system prompt was dismissed.
private struct AppLockCoverView: View {
    let onUnlock: () -> Void

    var body: some View {
        ZStack {
            Color.brandNavy.ignoresSafeArea()
            VStack(spacing: 16) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 40, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.9))
                Text("GradeThread is locked")
                    .font(.brandHeadline)
                    .foregroundStyle(.white.opacity(0.9))
                Button(action: onUnlock) {
                    Label("Unlock", systemImage: "faceid")
                        .font(.brandHeadline)
                        .padding(.horizontal, 24)
                        .padding(.vertical, 12)
                }
                .background(.white.opacity(0.15), in: Capsule())
                .foregroundStyle(.white)
                .accessibilityHint("Authenticate with Face ID, Touch ID, or your passcode to unlock the app")
            }
        }
        .accessibilityAddTraits(.isModal)
    }
}

// MARK: - Brand colors

/// Brand palette declared on `ShapeStyle where Self == Color` — NOT a plain
/// `Color` extension — so the leading-dot syntax resolves the way SwiftUI's own
/// `.red` / `.blue` do. Implicit-member lookup in a `some ShapeStyle` position
/// (`.foregroundStyle(.brandEmerald)`, `.fill(.brandRed)`, `.tint(.brandAmber)`)
/// only sees members declared here, never `static`s on `Color` itself — that's
/// why a `Color` extension produced "ShapeStyle has no member 'brandEmerald'".
/// Declaring them here also keeps `Color.brandNavy` and `let c: Color =
/// .brandNavy` working (since `Self == Color`), so this is a strict superset of
/// the old `Color` statics — with no `Color.brandRed` ambiguity from defining
/// the same name twice.
///
/// Mirrors the refreshed media kit (design.md §2 / §4A and the web app's
/// src/index.css) and reads from the asset catalog (US-192) so iOS swaps to the
/// high-contrast variant when Increase Contrast is on in Accessibility Settings.
///
/// `brandNavy` is the Obsidian Navy (#0C1E36) brand anchor. The Excellent grade
/// tier (7.0–9.0) uses the distinct Steel Navy (#0F3460) — `brandSteelNavy` —
/// per design.md §3B, so the anchor and the tier stay independently tunable.
extension ShapeStyle where Self == Color {
    static var brandNavy: Color { Color("BrandNavy") }
    static var brandSteelNavy: Color { Color("BrandSteelNavy") }
    static var brandRed: Color { Color("BrandRed") }
    static var brandEmerald: Color { Color("BrandEmerald") }
    static var brandAmber: Color { Color("BrandAmber") }
}

#Preview {
    ContentView()
}
