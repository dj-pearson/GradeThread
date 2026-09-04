import AuthenticationServices
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
    /// US-2496: the photo-profile table is per-tenant, and this view owns both
    /// boundaries that change the tenant. Optional because the `#Preview` at the
    /// bottom of this file builds a ContentView with no environment, and the
    /// non-optional form traps rather than returning nil.
    @Environment(PhotoProfileStore.self) private var photoProfileStore: PhotoProfileStore?

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

    /// US-1156: rate-limit inbound deep links and hold one that arrives before
    /// sign-in completes so it routes afterward instead of being dropped.
    @State private var lastDeepLinkAt: Date?
    /// Separate rate-limit clock for auth callbacks so a preceding widget tap's
    /// gate window can't drop a security-critical (pre-17.4 custom-scheme) auth
    /// callback that arrives right after it.
    @State private var lastAuthCallbackAt: Date?
    @State private var pendingDeepLink = PendingDeepLink()

    /// First-run welcome carousel. Shown once over everything at launch
    /// (gated by the persisted OnboardingState flag).
    @State private var showingOnboarding = !OnboardingState().hasCompleted

    /// US-696: optional Face ID / passcode lock. Owned here so it survives
    /// scene-phase transitions; MainShell renders its cover and Settings
    /// toggles it.
    @State private var appLock = AppLock()

    /// US-2503: the resolved buyer entitlement payload. Owned at the root so
    /// every buyer surface reads ONE answer — a per-screen store would let two
    /// screens disagree about the same plan, which is the same failure the
    /// server-side resolution exists to prevent, one level down.
    @State private var buyerEntitlements = BuyerEntitlementsStore()

    var body: some View {
        ProtectedRouteShell()
            .environment(authStore)
            .environment(networkMonitor)
            .environment(syncStatus)
            .environment(appLock)
            .environment(buyerEntitlements)
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
                // US-1410: replay an App Intent route that COLD-launched the app
                // (Siri / Shortcuts / Spotlight posted it in `perform()` before
                // this view subscribed to the deep-link bus, so the live post was
                // lost). `handleDeepLink` applies it now, or queues it until
                // sign-in completes.
                if let pending = DeepLinkRouter.drainPending() { handleDeepLink(pending) }
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
                // US-1156: rate-limit inbound URLs so another app can't flood the
                // custom scheme and spawn unbounded work / ANR us. Classify FIRST,
                // then gate PER CATEGORY — a single shared gate let a widget tap
                // consume the window and silently drop an auth callback that
                // arrived right after it.
                let now = Date.now
                // US-752: a home-screen widget tap arrives as a custom-scheme
                // URL (com.gradethread.app://widget/...). Route it (rate-limited,
                // it's the floodable surface) before the auth-callback handler.
                if let widgetLink = WidgetDeepLink.from(url: url) {
                    guard DeepLinkGate.shouldAccept(last: lastDeepLinkAt, now: now) else { return }
                    lastDeepLinkAt = now
                    handleWidgetDeepLink(widgetLink)
                    return
                }
                // Auth callbacks (universal link / pre-17.4 custom scheme) are
                // low-frequency and security-critical; their own gate still
                // prevents flooding without letting a widget tap starve them.
                guard DeepLinkGate.shouldAccept(last: lastAuthCallbackAt, now: now) else { return }
                lastAuthCallbackAt = now
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
                    // US-2496: refetch the photo-profile table for THIS account.
                    // The store already refuses to serve another tenant's table,
                    // so this is about warming the right one now rather than at
                    // whichever screen next happens to ask for it.
                    Task { await photoProfileStore?.loadIfNeeded() }
                    // US-1156: replay a deep link that arrived during sign-in.
                    if let queued = pendingDeepLink.take() { handleDeepLink(queued) }
                    // US-2535: onboarding can finish BEFORE sign-in, and in that
                    // order there is no session to write the answer against. So
                    // the push is attempted here too, not only at completion.
                    // It no-ops once written and after a skip.
                    Task { await UseCaseSync.pushIfNeeded() }
                case .signedOut:
                    // US-1493: drop the active workspace scope so the NEXT account
                    // on this device never inherits the previous user's
                    // X-Workspace-Owner header (which showed them an empty app or
                    // the wrong tenant). And bump the engine's scope epoch so any
                    // pull still in flight for the signed-out account discards its
                    // merge + cursor advance rather than re-saving those rows after
                    // the wipe below (a tenant leak on shared devices).
                    WorkspaceScope.clear()
                    // US-3101: the next account's Marketplaces badge must not
                    // open showing the last one's offers. Same reason the
                    // watermarks and detection baselines are cleared below.
                    sellerAttention.reset()
                    // Capture the engine strongly so the epoch bump still runs even
                    // though `syncEngine` is set to nil below — a late-returning pull
                    // must see the bumped epoch and discard.
                    if let engine = syncEngine { Task { await engine.invalidateScope() } }
                    // Reset the delta-sync cursors (US-633) so the next account
                    // does a clean full backfill instead of inheriting this
                    // user's watermark.
                    SyncWatermark().resetAll()
                    // US-1259: clear the new-sale/new-grade detection baselines
                    // too — they're global, so the next account's first sync
                    // would otherwise look like a flood of "new" rows.
                    backgroundRefreshService?.resetDetectionBaselines()
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
                    // US-1646: also wipe the per-account UI/draft stores so the
                    // next account on this device can't inherit the previous
                    // user's in-progress intake, staged capture draft, recent
                    // searches, or saved filter views (all device-local).
                    IntakeDraftStore.clear()
                    PhotoDraftStore.clear()
                    RecentSearchStore().clear()
                    SavedFilterStore().clear()
                    // US-694: wipe any lingering financial/account exports so
                    // the next user can't read the previous user's exports.
                    SecureTempFile.sweep()
                    // US-1499: purge the thumbnail byte/image cache so one
                    // account's photos don't persist at rest (disk URLCache) or in
                    // memory across accounts on a shared device. This choke point
                    // covers every sign-out path — explicit sign-out, account
                    // deletion, and token-expiry / Apple-credential-revoke.
                    ThumbnailLoader.shared.purge()
                    // US-1647: flush the EdgeAPI response cache so a cached GET
                    // can't serve the next account on this device.
                    Task { await EdgeAPI.shared.clearCache() }
                    // Drop cached signed URLs for the previous user's PRIVATE photos
                    // (capability tokens in the query string) so they don't linger
                    // in memory up to their TTL after sign-out on a shared device.
                    Task { await PhotoSignedURLProvider.shared.clearCache() }
                    PushService.shared.clearTokenOnSignOut()
                    // Capture strongly before nil-ing (mirrors the invalidateScope
                    // pattern above): a deferred `Task { await syncEngine?.stop() }`
                    // reads the `@State` optional when the task RUNS — after the
                    // synchronous `= nil` below — so `stop()` would never fire, leaking
                    // the realtime channel subscription and the engine's connectivity
                    // Task on every sign-out.
                    if let engine = syncEngine { Task { await engine.stop() } }
                    syncEngine = nil
                    if let rt = realtimeService { Task { await rt.stop() } }
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
                Task {
                    // US-1493: bump the scope epoch FIRST so any pull already in
                    // flight for the previous workspace discards its merge + cursor
                    // advance (and re-runs for the new scope) instead of leaking the
                    // old tenant's rows into the freshly-wiped store / poisoning the
                    // reset watermarks.
                    await syncEngine?.invalidateScope()
                    // US-1647: flush the tenant-keyed EdgeAPI response cache for
                    // the workspace we're leaving.
                    await EdgeAPI.shared.clearCache()
                    // US-2496: and refetch the photo-profile table, which is
                    // served per `workspaceOwnerId ?? userId` - the workspace we
                    // just moved into may not have the same entitlement.
                    await photoProfileStore?.loadIfNeeded()
                    // US-1211 AC3: drain the prior workspace's queued writes BEFORE
                    // re-scoping so a mutation queued under the old workspace can't
                    // carry into the new workspace's first sync pass. flushPending
                    // replays directly (scoped by each payload's own ids), so this
                    // pushes local intent to the correct tenant regardless of the
                    // active-workspace scope we're about to reset.
                    await syncEngine?.flushPending()
                    await MainActor.run {
                        SyncWatermark().resetAll()
                        // US-1259: the active workspace's row set is about to be
                        // swapped — reset detection baselines so the new
                        // workspace's existing rows don't read as "new".
                        backgroundRefreshService?.resetDetectionBaselines()
                        clearLocalTenantCache()
                    }
                    // US-1211: re-home the Realtime channel onto the new active
                    // owner — start() no-ops on an existing channel, so a workspace
                    // switch needs an explicit tear-down + re-subscribe.
                    if case let .signedIn(user) = authStore.phase {
                        let ownerId = WorkspaceScope.tenantOwnerId(selfId: user.id.uuidString)
                        await realtimeService?.resubscribe(userId: ownerId)
                    }
                    await syncEngine?.sync()
                    // US-1259: re-seed detection for the new workspace right
                    // after its first re-pull (baselines were just reset), so
                    // later arrivals in this workspace alert while its existing
                    // rows stay silent.
                    await backgroundRefreshService?.runForegroundDetection()
                }
            }
            .onChange(of: scenePhase) { _, newValue in
                if newValue == .active {
                    runForegroundPullIfNeeded()
                    // US-198: re-open the Realtime channel on foreground.
                    if case let .signedIn(user) = authStore.phase {
                        startRealtimeIfNeeded(userId: user.id.uuidString)
                    }
                    // US-1172: a user who revoked the app under Settings →
                    // Apple ID should be signed out, not left on a dead session.
                    signOutIfAppleCredentialRevoked()
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
                // Inventory list pulled-to-refresh — route to the engine, then
                // run new-sale/new-grade detection over what it merged (US-1259).
                Task {
                    await syncEngine?.sync()
                    await backgroundRefreshService?.runForegroundDetection()
                }
            }
            .onReceive(
                NotificationCenter.default.publisher(
                    for: ASAuthorizationAppleIDProvider.credentialRevokedNotification
                )
            ) { _ in
                // US-1172: Apple posts this when the user revokes the app while
                // it's running; verify + sign out.
                signOutIfAppleCredentialRevoked()
            }
            .onReceive(
                NotificationCenter.default.publisher(for: DeepLinkRouter.notificationName)
            ) { notification in
                guard let route = notification.userInfo?[DeepLinkRouter.routeUserInfoKey]
                        as? DeepLinkRoute else { return }
                handleDeepLink(route)
                // US-1410: the warm path handled this live — drop any persisted
                // copy so an intent run while the app was open can't replay a
                // stale route on the next cold launch.
                DeepLinkRouter.clearPending()
            }
            .fullScreenCover(isPresented: $showingOnboarding) {
                // US-747: persist completion + the chosen use case, and queue the
                // first-action routing (MainShell performs it).
                OnboardingView { useCase in
                    OnboardingState().complete(useCase: useCase)
                    showingOnboarding = false
                    // US-2535: write the answer to users.use_case, which is what
                    // the web dashboard and the activation checklist read. Until
                    // this, iOS captured the answer, reported it to telemetry and
                    // left the column NULL for ever.
                    Task { await UseCaseSync.pushIfNeeded() }
                    // US-1262: ask for push permission right after onboarding wraps
                    // — a reliable, in-context moment that doesn't depend on the
                    // user ever opening the Money tab. One-shot + OS-idempotent.
                    Task { await PushService.shared.requestPermissionAtReliableMomentIfNeeded() }
                }
            }
            // US-2875: Settings cleared the flag; this is what actually puts the
            // carousel back on screen in the same session.
            .onReceive(
                NotificationCenter.default.publisher(for: .onboardingReplayRequested)
            ) { _ in
                showingOnboarding = true
            }
    }

    /// US-752: translate a widget tap into the existing deep-link pipeline.
    /// `WidgetDeepLink` lives in the shared module (the widget extension can't
    /// see the app-only `DeepLinkRoute`), so the mapping happens here.
    private func handleWidgetDeepLink(_ link: WidgetDeepLink) {
        switch link {
        case .marketplaces:
            handleDeepLink(.marketplacesTab)
        case .money:
            handleDeepLink(.salesTab(inventoryItemId: nil))
        case .prospect:
            handleDeepLink(.prospect)
        }
    }

    private func handleDeepLink(_ route: DeepLinkRoute) {
        // US-1410: an explicit deep link (push tap, widget, Siri/Shortcut) is a
        // more specific intent than the onboarding "first action" nudge, which
        // `consumeOnboardingFirstAction` would otherwise apply when onboarding
        // finishes — clobbering the routed destination on a fresh install. Cancel
        // that nudge so the deep link wins. No-op when onboarding isn't pending.
        OnboardingState().pendingFirstAction = false
        // We don't own AppRouter directly (it lives inside MainShell).
        // Re-post via a more specific notification so MainShell can
        // mutate its router state without us threading a handle through
        // the env. ProtectedRouteShell is what's currently rendered when
        // .signedIn.
        // US-1156: a tap that arrives mid-auth (sign-in sheet on screen) used to
        // be dropped here; queue it and replay once signed in instead.
        guard case .signedIn = authStore.phase else {
            pendingDeepLink.queue(route)
            return
        }
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
        Task {
            await syncEngine?.sync()
            // US-1259: detect new sales/grades that the foreground pull merged,
            // so foreground-arrived rows raise the alert (and advance the
            // baseline) instead of only the BG task ever noticing them.
            await backgroundRefreshService?.runForegroundDetection()
        }
    }

    /// US-1172: if the user revoked Sign in with Apple for this app, the stored
    /// session is dead — sign out so they land back on LoginView instead of a
    /// half-broken authed shell. No-op for non-Apple sessions.
    private func signOutIfAppleCredentialRevoked() {
        guard case .signedIn = authStore.phase else { return }
        Task {
            if await AppleCredentialMonitor.isRevoked() {
                AppleCredentialMonitor.clear()
                await authStore.signOut()
            }
        }
    }

    private func startRealtimeIfNeeded(userId: String) {
        // Lazy-init the service the first time we have a sync engine
        // and a signed-in user. Re-entrancy guard inside the service
        // makes start(userId:) safe to call on every foreground.
        guard let engine = syncEngine else { return }
        if realtimeService == nil {
            realtimeService = RealtimeService(syncEngine: engine)
        }
        // US-1211: scope the channel to the ACTIVE workspace owner (self when in
        // the personal workspace), mirroring the SyncEngine pull scope. Without
        // this a workspace member only ever gets live updates for their OWN rows,
        // never the owner workspace they're viewing.
        let ownerId = WorkspaceScope.tenantOwnerId(selfId: userId)
        Task { @MainActor in
            await realtimeService?.start(userId: ownerId)
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
            try ctx.delete(model: LocalExpense.self)
            try ctx.delete(model: LocalSource.self)
            // US-3100: LocalSourcer was registered in the schema and wiped by
            // neither path, so the previous workspace's roster of people who
            // source for you stayed readable to the next one. `SourcerStore`
            // re-pulls it, so dropping it here costs a refresh and nothing else.
            try ctx.delete(model: LocalSourcer.self)
            // US-3100: the sourcing log is local-only and never synced, so
            // nothing re-pulls it. It is wiped here anyway: a shared iPad
            // handing the next workspace a list of what the last one was
            // considering is the same leak whether or not a server was
            // involved (US-2496).
            try ctx.delete(model: LocalProspectResult.self)
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
            try ctx.delete(model: LocalExpense.self)
            try ctx.delete(model: LocalSource.self)
            try ctx.delete(model: LocalSourcer.self)
            try ctx.delete(model: LocalPendingMutation.self)
            // US-3100: the local-only sourcing log goes with everything else.
            try ctx.delete(model: LocalProspectResult.self)
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
            // US-1259: run detection over the first sync of the session. On a
            // fresh session this seeds the new-sale/new-grade baselines at
            // sign-in so any row that later arrives (foreground OR background)
            // raises an alert, instead of the BG task's silent first-run seed
            // swallowing everything that landed before its first wake.
            await backgroundRefreshService?.runForegroundDetection()
            // US-1262: a user who already onboarded but never opens the Money tab
            // still needs the push prompt. After the first sync of a signed-in
            // session, surface it once — gated on onboarding completion so the
            // system dialog never lands over the welcome carousel (fresh users get
            // prompted from the onboarding-complete path instead).
            if OnboardingState().hasCompleted {
                await PushService.shared.requestPermissionAtReliableMomentIfNeeded()
            }
        }
    }
}

/// Switches between the login surface and the main shell based on the
/// observable auth phase. A `.loading` splash covers the brief window
/// before the SDK emits the initial session event on first launch.
struct ProtectedRouteShell: View {
    @Environment(AuthStore.self) private var authStore

    var body: some View {
        // US-1153: hermetic paywall journey. When the UI-test runner asks for it,
        // present the paywall directly — its prices/products resolve from the
        // scheme's attached `GradeThread.storekit` configuration, so the purchase
        // flow is exercised offline without a backend session. No-op in production.
        Group {
            if UITestSupport.directToPaywall {
                NavigationStack { PaywallView(userId: UITestSupport.stubUserId) }
            } else {
                routedBody
            }
        }
        // US-1492: a "Forgot password?" email link exchange emits `.passwordRecovery`
        // with a live recovery session. Auto-present the change-password sheet over
        // whatever surface is showing (login or the main shell) so the user actually
        // sets a NEW password instead of being silently signed in with the old one.
        .sheet(isPresented: Binding(
            get: { authStore.passwordRecoveryRequested },
            set: { authStore.passwordRecoveryRequested = $0 }
        )) {
            ChangePasswordSheet()
        }
    }

    @ViewBuilder
    private var routedBody: some View {
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
            // US-2017 AC2: the re-acceptance gate wraps the authenticated app.
            // Only here - a signed-out user has nothing to re-accept, and the
            // status endpoint reads the caller's own row, so it needs a session.
            LegalGate { MainShell() }
        }
    }
}

// MARK: - Main shell (TabView ↔ NavigationSplitView)

/// The five-section app surface. On compact horizontal width (iPhone, iPad
/// in Slide Over / Split View on the narrow side) it renders as a TabView;
/// at regular width (iPad full-screen) it switches to a NavigationSplitView
/// with a sidebar. The section model is shared so deep links + selection
/// state survive the layout switch.
/// An account-level condition the shell explains in one alert: the workspace
/// 2FA policy blocking this member (US-2532), or their membership being
/// revoked mid-session (US-794). Both are true of the ACCOUNT, not of the
/// screen that happened to surface them.
private struct WorkspaceNotice: Identifiable {
    let id = UUID()
    let title: String
    let message: String
    /// Where the user can actually fix it, when that is somewhere. nil for a
    /// revoked membership, which has already been recovered from.
    let fixURL: URL?
    /// US-2671: the fix is now a screen in THIS app. Kept separate from
    /// `fixURL` rather than replacing it, because "open the website" and
    /// "open a sheet" are different buttons and a notice may legitimately
    /// have neither.
    var fixesInApp: Bool = false
}

struct MainShell: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.modelContext) private var modelContext
    @Environment(AppLock.self) private var appLock
    @Environment(AuthStore.self) private var authStore
    // US-1158: injected from ContentView so the shell can reflect connectivity
    // drops into the global status banner the instant they happen (see the
    // `.onChange(of: networkMonitor.isConnected)` below).
    @Environment(NetworkMonitor.self) private var networkMonitor
    @Environment(\.openURL) private var openURL
    @Environment(SyncStatusStore.self) private var syncStatus
    @State private var router = AppRouter()
    /// US-2925: observed here so the hard-cap prompt can be bridged into the
    /// shell's single sheet slot. The soft banner still renders inside
    /// `planGatePresentation()`, which is an overlay and contends with nothing.
    @State private var planGateNotifier = PlanGateNotifier.shared

    /// The signed-in user, for the upgrade prompt. Nil while signed out.
    private var signedInUserId: UUID? {
        if case let .signedIn(user) = authStore.phase { return user.id }
        return nil
    }
    /// US-749: tab-independent orphan-listing count for the shell Reconcile
    /// banner. Refreshed on appear + foreground; the full list loads on tap.
    @State private var reconcileBadge = ReconcileBadgeStore()
    /// US-2557: unread notifications, for the Home tab badge and the app icon.
    @State private var unreadBadge = UnreadBadgeStore()
    /// US-3101: the Marketplaces badge — offers and deadlines.
    @State private var sellerAttention = SellerAttentionStore()
    /// US-2532 / US-794: an account-level workspace condition the app must
    /// explain ONCE rather than as a per-screen error. Both arrive on
    /// whichever request happened to be in flight, and neither is about the
    /// screen the user is looking at.
    @State private var workspaceNotice: WorkspaceNotice?
    // US-2671: the 2FA notice opens enrollment in-app. US-2925 moved it into
    // ShellSheet.twoFactor - it was the shell's SECOND sheet modifier.

    /// US-1157: per-scene state restoration for iPad multi-window. `@SceneStorage`
    /// is scoped to THIS scene (window) and survives teardown/relaunch, so two
    /// windows each remember their own resting section + open item independently.
    /// `storedSectionRaw` is the resting ``AppSection`` raw value; `focusedItemId`
    /// is the inventory item whose canvas is open (written by
    /// ``ItemCanvasSceneHost`` and shared via the same scene-storage key).
    @SceneStorage("shell.section") private var storedSectionRaw = ""
    @SceneStorage("shell.focusedItemId") private var focusedItemId = ""
    /// Guards the one-shot restore so a re-`appear` (tab switch, sheet dismiss)
    /// can't clobber live navigation with a stale persisted value.
    @State private var didRestoreScene = false

    /// US-189: PhotoIntakeView seeded from a Share Extension batch. Set
    /// when MainShell drains an inbox batch, cleared on dismiss. Using a
    /// fullScreenCover at the shell level so the present survives a
    /// tab switch + lands the user on the same intake surface the Add
    /// sheet would.
    /// US-2925: the shell's single cover slot. Was two competing
    /// `.fullScreenCover` modifiers; see ``ShellCover``.
    @State private var shellCover: ShellCover?
    /// US-1181: when a shared batch fully fails to decode we used to consume it
    /// silently, so the user shared photos and got no signal. Drives an alert.
    @State private var shareImportError: String?

    /// US-804: the one-time post-signup plan-selection step. Set on first
    /// sign-in when ``PlanSelectionState`` says this fresh account hasn't been
    /// offered yet; cleared (and marked offered) when the user picks a plan or
    /// continues on Free.

    /// Identifiable wrapper so the plan step drives a single `.fullScreenCover(item:)`.
    private struct PlanStepPresentation: Identifiable {
        let userId: UUID
        var id: UUID { userId }
    }

    /// US-2925: the shell's ONE full-screen cover slot.
    ///
    /// `.fullScreenCover` has exactly the same single-slot rule as `.sheet`, and
    /// the shell carried two of them — the shared-photo intake and the
    /// post-signup plan step. `check-chained-sheets.py` never looked at covers,
    /// so the pair sat there unflagged next to the three sheets it also could
    /// not see.
    ///
    /// The mutual exclusion was already true and already worked around by hand:
    /// `drainSharedInboxIfNeeded` gates itself on `planStep == nil` precisely
    /// because both could not be up at once. This states it in the type instead
    /// of in a guard clause that a future caller can forget.
    private enum ShellCover: Identifiable {
        case sharedIntake(ShareInboxConsumer.DrainedBatch)
        case planStep(PlanStepPresentation)

        var id: String {
            switch self {
            case .sharedIntake(let batch): return "intake-\(batch.id)"
            case .planStep(let step): return "plan-\(step.id)"
            }
        }
    }

    var body: some View {
        // Shadowing-binding pattern: `@State` owns the Observable, then a
        // local `@Bindable` exposes write-bindings to its properties for
        // SwiftUI sheets / popovers.
        @Bindable var router = router
        VStack(spacing: 0) {
            SyncStatusBar()
                .accessibleAnimation(.easeInOut(duration: 0.2), value: router.selection)
            // US-749: surface unmatched eBay listings on every tab, not just
            // inside Marketplaces. Tapping opens Reconciliation directly.
            if reconcileBadge.hasOrphans {
                ReconcileBanner(
                    count: reconcileBadge.orphanCount,
                    onTap: {
                        AppRouter.haptic()
                        router.shellSheet = .reconciliation
                    },
                    onSnooze: {
                        // US-1262: let the user dismiss/snooze the persistent
                        // reminder so it isn't a permanent nag. It re-surfaces when
                        // the snooze window elapses or new unmatched listings appear.
                        AppRouter.haptic()
                        reconcileBadge.snooze()
                    }
                )
                .accessibleAnimation(.easeInOut(duration: 0.2), value: reconcileBadge.hasOrphans)
            }
            Group {
                if horizontalSizeClass == .regular {
                    SidebarSplitView(router: router)
                } else {
                    TabBarShell(
                        router: router,
                        unreadCount: unreadBadge.unreadCount,
                        attentionCount: sellerAttention.badgeCount
                    )
                }
            }
        }
        .confirmationDialog(
            "Add item",
            isPresented: $router.showingAddSheet,
            titleVisibility: .visible
        ) {
            Button("Photos first") {
                router.startIntake(.photoFirst)
            }
            Button("Details first") {
                router.startIntake(.detailsFirst)
            }
            Button("Bulk with AI") {
                router.startIntake(.autoLister)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Shoot the garment and let AI read the tag, type the details yourself, or send up to 200 photos through AutoLister.")
        }
        // US-2532: the workspace 2FA policy blocked this member. One notice,
        // carrying the EDGE's sentence, with the route that actually fixes it.
        // US-2671 built that route ON DEVICE, so the notice now opens the
        // enrollment sheet instead of sending a phone-only member to a browser.
        .onReceive(
            NotificationCenter.default.publisher(for: .workspaceMfaRequired)
        ) { notification in
            let sent = notification.userInfo?[WorkspaceScope.noticeMessageKey] as? String
            let fallback = EdgeAPIError.workspaceMfaRequired(detail: nil).errorDescription
            workspaceNotice = WorkspaceNotice(
                title: "Two-factor authentication required",
                message: sent ?? fallback ?? "",
                fixURL: nil,
                fixesInApp: true
            )
        }
        // US-794: this notification has been posted since June and nothing
        // has ever observed it, so the "brief notice" its own doc comment
        // promises never appeared — the workspace silently switched back to
        // personal and the user saw their own data where a colleague's had
        // been. Same surface, so it is fixed here rather than filed.
        .onReceive(
            NotificationCenter.default.publisher(for: .workspaceAccessRevoked)
        ) { _ in
            workspaceNotice = WorkspaceNotice(
                title: "Workspace access ended",
                message: EdgeAPIError.workspaceAccessRevoked.errorDescription ?? "",
                fixURL: nil
            )
        }
        .alert(
            workspaceNotice?.title ?? "",
            isPresented: Binding<Bool>(
                get: { workspaceNotice != nil },
                set: { presented in if !presented { workspaceNotice = nil } }
            )
        ) {
            if let url = workspaceNotice?.fixURL {
                Button("Open gradethread.com") { openURL(url) }
            }
            if workspaceNotice?.fixesInApp == true {
                // Dismissing the alert and presenting in the same tick loses
                // the sheet on iOS, so the flag is set and the alert's own
                // dismissal drives the presentation.
                Button("Set up two-factor") { router.shellSheet = .twoFactor }
            }
            Button("OK", role: .cancel) {}
        } message: {
            Text(workspaceNotice?.message ?? "")
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
                // US-1149: NO opacity transition here — a fade-in means iOS can
                // capture the App Switcher snapshot while the cover is still
                // semi-transparent, leaking the financial figures behind it. The
                // cover must appear instantly (and fully opaque) the moment the
                // scene goes inactive.
                PrivacyCoverView()
            }
        }
        // US-1158: reflect connectivity into the global status banner the moment
        // it drops, so a cold launch while offline shows the offline state
        // immediately instead of waiting for the SyncEngine's connectivity
        // stream (which only starts after sign-in/engine boot). Idempotent with
        // the engine, which also sets .offline on disconnect; reconnect is left
        // to the engine so it can drive the .syncing/.idle transition + sync.
        .onChange(of: networkMonitor.isConnected) { _, connected in
            if !connected { syncStatus.set(.offline) }
        }
        // US-1157: persist the resting section to this scene's storage on every
        // change so a window teardown/relaunch restores the same tab. The `.add`
        // pseudo-section is never stored (it's transient).
        .onChange(of: router.selection) { _, newValue in
            if let raw = SceneRestoration.persistableRaw(for: newValue) {
                storedSectionRaw = raw
            }
        }
        .task {
            // US-1157: restore this scene's resting section + open item from
            // @SceneStorage before any other appear-time routing runs, so a
            // relaunched/teardown-recovered window lands where it left off.
            restorePersistedScene(router: router)
            // US-804/US-1410: offer the one-time post-signup plan step BEFORE
            // draining shared photos. Both are ``ShellCover`` cases and the
            // shell has one cover slot, so the drain is gated on
            // `shellCover == nil` (US-2925 — it used to be gated on
            // `planStep == nil`, which was the same rule enforced by hand
            // against two separate modifiers).
            offerPlanSelectionIfNeeded()
            await drainSharedInboxIfNeeded()
            // US-749: load the orphan-listing count for the shell Reconcile banner.
            refreshReconcileBadge()
            // US-2557: and the unread count behind the Home badge.
            await unreadBadge.refresh()
            // US-3101: alongside the unread count, on the same foreground
            // signal. Not polled — each refresh is real eBay calls against an
            // app-wide rate limit.
            await sellerAttention.refresh()
            // US-696: cold-launch / first-render unlock prompt.
            if appLock.state == .locked { await appLock.authenticate() }
        }
        .onChange(of: scenePhase) { _, newValue in
            if newValue == .active {
                Task { await drainSharedInboxIfNeeded() }
                // US-749: re-check orphan listings on foreground (an eBay sync
                // while backgrounded may have produced new unmatched rows).
                refreshReconcileBadge()
                // US-2557: a push may have raised the badge while we were away,
                // and rows may have been read on another device — the server
                // only ever RAISES it, so the app is what brings it back down.
                Task {
                    await unreadBadge.refresh()
                    await sellerAttention.refresh()
                }
                // US-696: prompt to unlock when returning to the foreground.
                if appLock.state == .locked { Task { await appLock.authenticate() } }
            }
        }
        // The shell's four sheets share ONE modifier — see `AppRouter.ShellSheet`
        // for why that is not merely tidier. `onDismiss` fires for whichever was
        // up, so it does the cleanup both of the old per-sheet handlers did:
        // re-count orphan listings (Reconciliation may have resolved some) and
        // drop the deep-linked support thread id so opening the inbox by hand
        // next time doesn't reopen it.
        .sheet(item: $router.shellSheet, onDismiss: {
            refreshReconcileBadge()
            router.supportTicketId = nil
        }) { sheet in
            switch sheet {
            case .globalSearch:
                GlobalSearchView()
            case .toolsHub:
                ToolsHubView(router: router, orphanCount: reconcileBadge.orphanCount)
            case .reconciliation:
                NavigationStack { ReconciliationView() }
            case .support:
                SupportTicketsView(initialTicketId: router.supportTicketId)
            case .twoFactor:
                TwoFactorSheet()
            case .planGate(let gate):
                UpgradePromptView(gate: gate, userId: signedInUserId)
            }
        }
        // US-2925: ONE cover slot. See ``ShellCover``.
        //
        // US-804: the plan step is one-time and post-signup, presented over the
        // shell so it gates entry visually; "Continue with Free" always
        // dismisses. The shared intake walks a multi-share session through each
        // batch one at a time.
        .fullScreenCover(item: $shellCover) { cover in
            switch cover {
            case .sharedIntake(let drained):
                NavigationStack {
                    PhotoIntakeView(initialPhotos: drained.slotPhotos)
                }
                .onDisappear {
                    ShareInboxConsumer.finish(drained)
                    // Drain the next pending batch (if any).
                    Task { await drainSharedInboxIfNeeded() }
                }
            case .planStep(let step):
                OnboardingPlanStepView(userId: step.userId) {
                    shellCover = nil
                    // US-1410: resume the shared-photo drain that was gated
                    // while the plan step was presented.
                    Task { await drainSharedInboxIfNeeded() }
                }
            }
        }
        // US-805: shell-level soft warning banner (80% X-Plan-Warning), fed by
        // EdgeAPI's centralized plan-gate interceptor. The hard-cap prompt is
        // ShellSheet.planGate, bridged below — see US-2925 in
        // PlanGatePresentation.swift for why it is no longer its own sheet.
        .planGatePresentation()
        .onChange(of: planGateNotifier.activePrompt) { _, gate in
            // A hard cap outranks whatever else is up: the action the user just
            // took did not happen, and telling them why matters more than the
            // screen it replaced. Replacing rather than stacking is the whole
            // point - the old code tried to stack and lost the slot instead.
            if let gate { router.shellSheet = .planGate(gate) }
        }
        .onChange(of: router.shellSheet) { old, new in
            // Closing the prompt has to clear the notifier too, or the next 402
            // sets an unchanged value and onChange never fires again.
            if case .planGate = old, new == nil {
                planGateNotifier.activePrompt = nil
            }
        }
        // US-1181: tell the user when shared photos couldn't be read.
        // US-1273: resume draining only after the alert is dismissed, so each
        // queued empty batch surfaces its OWN alert instead of being silently
        // overwritten by the next drain.
        .alert(
            "Couldn't read the shared photos",
            isPresented: Binding(
                get: { shareImportError != nil },
                set: { presented in
                    guard !presented else { return }
                    shareImportError = nil
                    Task { await drainSharedInboxIfNeeded() }
                }
            )
        ) {
            Button("OK") {}
        } message: {
            Text(shareImportError ?? "")
        }
    }

    /// US-804: present the one-time plan step to a freshly-signed-up account.
    /// Resolves the pending signup flag to the now-known user id, then offers the
    /// step only when this account is eligible and hasn't already been shown it.
    /// Existing users (no pending signup) are never eligible, so never prompted.
    private func offerPlanSelectionIfNeeded() {
        guard case let .signedIn(user) = authStore.phase else { return }
        let state = PlanSelectionState()
        // US-1523: the pending flag resolves only onto the account whose email
        // signed up — a different account on this device never inherits it.
        state.resolvePending(userId: user.id, email: user.email)
        if state.shouldOffer(userId: user.id) {
            shellCover = .planStep(PlanStepPresentation(userId: user.id))
        }
    }

    /// Pulls the next Share Extension batch off the inbox + presents the
    /// PhotoIntakeView pre-staged with its photos. No-op when nothing's
    /// pending, the user's signed out, or we're mid-present (the
    /// fullScreenCover guard).
    @MainActor
    private func drainSharedInboxIfNeeded() async {
        // US-1410: the one-time post-signup plan step and the shared-intake batch
        // both present via `fullScreenCover(item:)`, and SwiftUI honors only one
        // full-screen presentation per view — so don't drain while the plan step
        // is up, or the batch silently fails to present (stranding the shared
        // photos). The plan step's dismissal resumes the drain.
        guard shellCover == nil else { return }
        // Don't pop a new batch while one is presented OR while a previous
        // batch's error alert is still up: presenting/draining the next batch
        // would dismiss that alert and swallow the error (US-1273). The alert's
        // dismiss handler resumes draining once the user has seen it.
        guard shareImportError == nil else { return }
        guard let drained = await ShareInboxConsumer.popNext() else { return }
        // Empty drain (every photo failed to decode) — finish + tell the user
        // (US-1181: previously silent), then STOP. We resume on the next batch
        // only after this alert is dismissed (US-1273), so a following batch —
        // successful OR another empty one — can't suppress this error.
        guard !drained.slotPhotos.isEmpty else {
            ShareInboxConsumer.finish(drained)
            shareImportError = "We couldn't read the photos you shared. Try sharing them again from the Photos app."
            return
        }
        Telemetry.event("share_extension_intake_opened")
        shellCover = .sharedIntake(drained)
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
        guard state.pendingFirstAction else { return }
        state.pendingFirstAction = false
        guard let useCase = state.selectedUseCase else {
            // US-1178: skip path — nudge toward the first item via the add-method
            // chooser rather than dropping the user on a bare shell.
            router.selection = .home
            router.showingAddSheet = true
            return
        }
        let action = useCase.firstAction
        router.selection = action.section
        if let intake = action.intake {
            router.startIntake(intake)
        }
    }

    /// US-749: refresh the shell-level orphan-listing count, scoped to the
    /// active workspace owner. Best-effort — the store keeps the last value on
    /// failure. No-op when signed out.
    private func refreshReconcileBadge() {
        guard case let .signedIn(user) = authStore.phase else { return }
        let ownerId = WorkspaceScope.tenantOwnerId(selfId: user.id.uuidString)
        Task { await reconcileBadge.refresh(userId: ownerId) }
    }

    private func apply(route: DeepLinkRoute, router: AppRouter) {
        switch route {
        case let .salesTab(inventoryItemId):
            // US-752: a sale.created / payout.* push that carried the item id
            // drills into that item's canvas (which shows its sale + payout
            // detail) instead of dumping the user on the Money tab home. No id
            // (e.g. a payout digest, or the widget's Money tap) → the tab root.
            router.selection = .sales
            router.salesPath = NavigationPath()
            if let id = inventoryItemId, let item = fetchInventoryItem(id: id) {
                router.salesPath.append(item)
            }
        case .marketplacesTab:
            router.selection = .marketplaces
        case .reconnectEbay:
            // US-1262: select Marketplaces AND ask the connection card to open the
            // eBay OAuth sheet immediately. MarketplacesView listens for
            // `.ebayReconnectRequested` (its `.onReceive` is live even while the
            // tab is in the background of the TabView), so the sheet presents the
            // moment we post — the user lands mid-reconnect, not on a static tab.
            router.selection = .marketplaces
            router.marketplacesPath = NavigationPath()
            // Latch the intent (consumed by MarketplacesView's `.task` if the tab
            // is mounting cold) AND post the wake signal (caught by its
            // `.onReceive` if it's already live). Exactly one path fires OAuth.
            EbayReconnectLatch.shared.request()
            NotificationCenter.default.post(name: .ebayReconnectRequested, object: nil)
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
        case .captureItem:
            // US-1134: "Snap to value" Siri/Shortcut → photo-first capture. Rest
            // to Home so the intake pushes onto a predictable stack.
            router.selection = .home
            router.homePath = NavigationPath()
            router.startIntake(.photoFirst)
        case .addItem:
            // US-1134: the Add Item Siri/Shortcut → the add-method chooser sheet.
            router.selection = .home
            router.showingAddSheet = true
        case let .supportTickets(ticketId):
            // US-1136: open the native support inbox over the shell, drilling into
            // the referenced thread when the push carried one.
            router.supportTicketId = ticketId
            router.shellSheet = .support
        case .prospect:
            // US-3101: a quick action, the Lock Screen widget or Siri. Home to a
            // clean stack, then park the request for DashboardView to present —
            // the sheet belongs to whichever view owns the one sheet slot.
            router.selection = .home
            router.homePath = NavigationPath()
            router.pendingToolModule = .prospect
        case .scout:
            router.selection = .home
            router.homePath = NavigationPath()
            router.pendingToolModule = .scout
        case .inventoryDrafts:
            // US-3101: the listings already written and not yet earning.
            router.selection = .inventory
            router.inventoryPath = NavigationPath()
            router.pendingInventoryFilter = .drafts
        }
    }

    /// US-1157: restore this scene's persisted resting section + open item.
    /// Runs once per scene lifetime (guarded by `didRestoreScene`). The
    /// `(section, item)` pair is consistent because the section is persisted
    /// whenever it changes and the canvas is only ever shown while its host
    /// section is active — so on restore we re-select the section and re-push
    /// the item onto that same section's path. A not-yet-synced item simply
    /// leaves the window on its restored section (the list), never a dead end.
    private func restorePersistedScene(router: AppRouter) {
        guard !didRestoreScene else { return }
        didRestoreScene = true
        if let section = SceneRestoration.restoreSection(from: storedSectionRaw) {
            router.selection = section
        }
        guard let itemId = SceneRestoration.restorableItemId(from: focusedItemId),
              let item = fetchInventoryItem(id: itemId) else { return }
        switch router.selection {
        case .home:         router.homePath.append(item)
        case .inventory:    router.inventoryPath.append(item)
        case .sales:        router.salesPath.append(item)
        case .marketplaces, .settings, .add:
            // No canvas host on these sections — surface the item under
            // Inventory so the restored selection still resolves.
            router.selection = .inventory
            router.inventoryPath.append(item)
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

// MARK: - Scene-restoration host (US-1157)

/// Wraps ``ItemCanvasView`` so the active scene (window) remembers which item
/// is open, enabling per-scene state restoration on iPad multi-window. Writes
/// the item id to the same `@SceneStorage("shell.focusedItemId")` key
/// ``MainShell`` reads on restore; clears it on disappear only when it still
/// owns the slot, so navigating to a different item (which appears before the
/// previous one disappears) doesn't wipe the newer id.
private struct ItemCanvasSceneHost: View {
    let item: LocalInventoryItem
    @SceneStorage("shell.focusedItemId") private var focusedItemId = ""

    var body: some View {
        ItemCanvasView(item: item)
            .onAppear { focusedItemId = item.id }
            .onDisappear {
                if focusedItemId == item.id { focusedItemId = "" }
            }
    }
}

// MARK: - iPhone / compact layout

private struct TabBarShell: View {
    @Bindable var router: AppRouter
    /// US-2557: unread notifications, owned and refreshed by ``MainShell``.
    /// Passed as a count rather than the store, so the renderer does not take a
    /// dependency on something only the shell has a reason to drive.
    var unreadCount: Int = 0

    /// US-3101: offers awaiting a reply plus returns and disputes with a
    /// deadline. Nil rather than 0, and hidden entirely at zero.
    ///
    /// Marketplaces, not Home: this is the number that decides whether a seller
    /// LOSES money, and it was on a tab with no badge at all. Home's unread
    /// count stays where it is.
    var attentionCount: Int?

    var body: some View {
        TabView(selection: router.tabSelectionBinding) {
            NavigationStack(path: $router.homePath) {
                DashboardView(router: router)
                    .navigationDestination(for: IntakeRoute.self, destination: intakeDestination)
                    .navigationDestination(for: LocalInventoryItem.self) { item in
                        ItemCanvasSceneHost(item: item)
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
                        // US-749: Tools hub — the discoverable home for the
                        // secondary power modules (Scout/Snap/AutoLister/Grades/
                        // Reconcile/Referrals/Verified).
                        ToolbarItem(placement: .topBarLeading) {
                            ToolsButton(router: router)
                        }
                        // US-678: global search across inventory/listings/sales/sources.
                        ToolbarItem(placement: .topBarTrailing) {
                            Button {
                                router.shellSheet = .globalSearch
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
            // US-2557: unread notifications. SwiftUI renders nothing at 0, so
            // this needs no conditional — and Home is the tab because the
            // notification surface lives on the dashboard and the 5-tab limit
            // is already spent.
            .badge(unreadCount)
            .tag(AppSection.home)

            NavigationStack(path: $router.inventoryPath) {
                InventoryPlaceholder(router: router)
                    .navigationDestination(for: IntakeRoute.self, destination: intakeDestination)
                    .navigationDestination(for: LocalInventoryItem.self) { item in
                        ItemCanvasSceneHost(item: item)
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
                    Label("Add item", systemImage: "plus.circle.fill")
                }
                .tag(AppSection.add)

            NavigationStack(path: $router.salesPath) {
                MoneyPlaceholder()
                    .navigationDestination(for: IntakeRoute.self, destination: intakeDestination)
                    // US-752: a sale.created / payout.* push (or a Money-row tap)
                    // drills into the sale's item canvas on this tab.
                    .navigationDestination(for: LocalInventoryItem.self) { item in
                        ItemCanvasSceneHost(item: item)
                    }
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
            // US-3101: what eBay is waiting on. `.badge(Int?)` renders nothing
            // for nil, which is the whole reason the store hands out an
            // optional rather than a count that can be 0.
            .badge(attentionCount)
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
        if router.selection.ownsContentNavigation {
            // US-1260: Money/Marketplaces/Settings render their whole UI plus
            // their own in-view navigation in a single NavigationStack (US-1199).
            // In the three-column layout that left the detail (right) column
            // stuck on a "Make a selection" placeholder nothing ever filled —
            // the layout looked broken. Use a two-column split for these
            // sections, where the section's own stack IS the detail column, so
            // in-view links and value-based deep links share one place to land.
            NavigationSplitView {
                sidebar
            } detail: {
                sectionStack
            }
        } else {
            // Home/Inventory keep the three-column list→detail layout: their
            // value-based NavigationLinks resolve in the detail column.
            NavigationSplitView {
                sidebar
            } content: {
                contentColumn
            } detail: {
                detailColumn
            }
        }
    }

    /// US-1260: detail column for sections that own their navigation. The
    /// section's main view sits at the root of a NavigationStack bound to its
    /// per-section path, so both in-view destination links and value-based deep
    /// links (e.g. a `sale.created` push, a negotiation deep link) resolve here.
    private var sectionStack: some View {
        NavigationStack(path: detailPathBinding) {
            sectionRoot
                .navigationDestination(for: LocalInventoryItem.self) { item in
                    ItemCanvasSceneHost(item: item)
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

    @ViewBuilder
    private var sectionRoot: some View {
        switch router.selection {
        case .sales:        MoneyPlaceholder()
        case .marketplaces: MarketplacesPlaceholder()
        case .settings:     SettingsView()
        default:            EmptyView()
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
                AddMethodMenu(router: router, primaryLabel: "Add item")
            }
            // US-749: Tools hub reachable from the iPad sidebar toolbar too.
            ToolbarItem(placement: .secondaryAction) {
                ToolsButton(router: router)
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
            // Home/Inventory use value-based NavigationLinks resolved by the
            // detail column's NavigationStack — they stay unwrapped.
            DashboardView(router: router)
        case .inventory:
            InventoryListView(router: router)
        // US-1199/US-1260: Money/Marketplaces/Settings own their navigation in a
        // single content-column NavigationStack, so they render in the
        // two-column layout's `sectionStack` (detail column) instead — this
        // branch is never reached for them. Kept exhaustive for the compiler.
        case .sales, .marketplaces, .settings, .add:
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
                    ItemCanvasSceneHost(item: item)
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
///
/// String-backed so it round-trips through `@SceneStorage` for per-scene
/// state restoration (US-1157); the raw values are persisted, so keep them
/// stable.
enum AppSection: String, Hashable {
    case home, inventory, add, sales, marketplaces, settings

    /// US-1199/US-1260: sections that render their whole UI plus their own
    /// in-view navigation inside one NavigationStack. On iPad they use a
    /// two-column split (sidebar + that stack as the detail column) so there's
    /// no dead detail placeholder. Home/Inventory instead drive a three-column
    /// list→detail layout, so they return `false`.
    var ownsContentNavigation: Bool {
        switch self {
        case .sales, .marketplaces, .settings: return true
        case .home, .inventory, .add:          return false
        }
    }
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

    /// Which shell-level sheet is up, if any.
    ///
    /// ONE optional rather than one boolean per surface, because a view gets
    /// ONE sheet modifier. These four used to be four chained
    /// `.sheet(isPresented:)` modifiers on the shell, which is undefined in
    /// SwiftUI — see ``ToolModule``. It also makes the mutual exclusion
    /// explicit: two of these can never sensibly be up at once, and with
    /// booleans nothing said so.
    var shellSheet: ShellSheet?

    /// US-1136: the support thread a `support.reply` deep link asked for, opened
    /// with ``ShellSheet/support``. Nil when the inbox was opened by hand.
    var supportTicketId: String?

    /// US-3101: a sourcing module a quick action, widget or Siri phrase asked
    /// for, waiting for Home to present it.
    ///
    /// The router cannot present it itself: ``ToolModule`` sheets are owned by
    /// whichever screen shows them, because a view gets ONE sheet slot (see
    /// ``ToolModule``). So the route parks the request here and DashboardView
    /// picks it up and CLEARS it, which is also what stops a backgrounded app
    /// re-presenting Prospect every time it returns to the foreground.
    var pendingToolModule: ToolModule?

    /// US-3101: Inventory should open on drafts rather than everything.
    ///
    /// Consumed by the inventory list the same way — read once, then cleared.
    var pendingInventoryFilter: InventoryDeepFilter?

    /// US-3106: a search term a demand chip handed to Scout, waiting for the
    /// Scout sheet to open on it.
    ///
    /// Parked here for the same reason as ``pendingToolModule``, which it always
    /// travels with: Home owns the sheet, so the module and what it should open
    /// on have to arrive together. Read once by the presentation, then cleared.
    var pendingScoutKeyword: String?

    /// US-3100: a saved Prospect verdict the seller tapped on Home, waiting for
    /// ``ProspectView`` to open on it.
    ///
    /// Parked here for the same reason as ``pendingToolModule``: Home owns the
    /// sheet, so the row that was tapped and the module that presents it have
    /// to be handed over together. Read once, then cleared.
    var pendingProspectResultId: String?

    /// US-3106: read the parked Scout term and clear it in one step.
    ///
    /// One method rather than a read at the call site and a clear somewhere
    /// else: the clear is the part that gets forgotten, and forgetting it means
    /// every later open of Scout re-applies a search the seller made once.
    func takePendingScoutKeyword() -> String? {
        defer { pendingScoutKeyword = nil }
        return pendingScoutKeyword
    }

    /// The filters a deep link can ask the inventory list to apply.
    enum InventoryDeepFilter: Equatable {
        /// Items with a draft listing and nothing live: written, not yet earning.
        case drafts
    }

    /// The shell-level sheets, in the order the toolbar offers them.
    enum ShellSheet: Identifiable, Equatable {
        /// US-678: global search.
        case globalSearch
        /// US-749: the Tools hub (Scout / Snap / AutoLister / Grades /
        /// Reconcile / Referrals / Verified), reachable from any tab.
        case toolsHub
        /// US-749: Reconciliation, opened from the shell-level orphan banner so
        /// it is reachable regardless of which tab is active.
        case reconciliation
        /// US-1136: the native support inbox.
        case support
        /// US-2925: the two-factor setup prompt, opened from the security
        /// notice banner. Folded in here because it was a SECOND `.sheet`
        /// modifier on the shell, and a view has one sheet slot — see the
        /// comment on the shell's `.sheet(item:)` for what that cost.
        case twoFactor
        /// US-2925: the hard-cap upgrade prompt. Lived in
        /// `planGatePresentation()` as its own `.sheet`, which made it the
        /// shell's THIRD sheet modifier and is what collapsed the Dashboard's
        /// module sheets. Bridged in from ``PlanGateNotifier/activePrompt``.
        case planGate(PlanGateError)

        var id: String {
            switch self {
            case .globalSearch: return "globalSearch"
            case .toolsHub: return "toolsHub"
            case .reconciliation: return "reconciliation"
            case .support: return "support"
            case .twoFactor: return "twoFactor"
            case .planGate(let gate): return "planGate-\(gate.id)"
            }
        }
    }

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
                    // Tapping Add presents the "Add item" chooser (photo-first
                    // single item / details-first / AutoLister bulk-add) rather
                    // than jumping straight into single-item photo capture — the
                    // bulk path was otherwise undiscoverable from the tab bar, so
                    // Add looked like an ~8-photo single-listing tool. Matches the
                    // iPad sidebar. Don't change `selection`: that snaps the tab
                    // bar back after the brief tap state.
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
            } label: { Label("Photos first", systemImage: "camera") }
            Button {
                AppRouter.haptic()
                router.startIntake(.detailsFirst)
            } label: { Label("Details first", systemImage: "square.and.pencil") }
            Button {
                AppRouter.haptic()
                router.startIntake(.autoLister)
            } label: { Label("Bulk with AI", systemImage: "wand.and.stars") }
        } label: {
            if let primaryLabel {
                Label(primaryLabel, systemImage: "plus.circle.fill")
            } else {
                Image(systemName: "plus.circle")
                    .accessibilityLabel("Add item")
            }
        }
    }
}

// MARK: - Tools button (US-749)

/// Toolbar control that opens the Tools hub. A single, stable entry point on
/// Home (iPhone) and the iPad sidebar so the secondary modules are discoverable
/// without hunting through the Dashboard or Settings.
private struct ToolsButton: View {
    let router: AppRouter

    var body: some View {
        Button {
            AppRouter.haptic()
            router.shellSheet = .toolsHub
        } label: {
            Image(systemName: "square.grid.2x2")
        }
        .accessibilityLabel("Tools")
        .accessibilityHint("Scout, Snap, AutoLister, grades, reconcile, referrals, and verified seller")
    }
}

// MARK: - Tab placeholders

/// Each tab gets a stub until its dedicated story lands. They're real
/// `View`s, not text labels, so the surrounding NavigationStack + toolbar
/// patterns are exercised in CI immediately.
private struct InventoryPlaceholder: View {
    let router: AppRouter

    var body: some View {
        InventoryListView(router: router)
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
    /// US-1259: the injected/AppDelegate-owned background-refresh service — the
    /// SAME instance holding the live container + SyncEngine. The toggle reads
    /// and writes through this, never a throwaway, so the scheduler the user
    /// controls is the one that actually runs.
    @Environment(\.backgroundRefreshService) private var backgroundRefreshService
    /// Mirrors the service's `isEnabled` so the toggle binds correctly; seeded
    /// to the default-ON value and synced from the injected service in
    /// `onAppear`, then written through on change.
    @State private var bgRefreshEnabled: Bool = true
    /// Which of Settings' sheets is up.
    ///
    /// Settings offers nine of them and used to chain nine
    /// `.sheet(isPresented:)` modifiers onto one List. A view has ONE sheet
    /// slot, so those nine modifiers were competing for it — see ``ToolModule``
    /// for the symptom that produces. One optional, one modifier, and the
    /// mutual exclusion is now stated rather than assumed.
    @State private var sheet: SettingsSheet?
    // US-1201: confirm sign-out — it wipes local SwiftData + the offline
    // mutation queue, so an accidental tap shouldn't discard unsynced work.
    @State private var confirmingSignOut = false
    @State private var signingOut = false
    // US-648 preferences
    @State private var measurementUnit: MeasurementUnit = AppPreferences.measurementUnit
    @State private var currencyCode: String = AppPreferences.currencyCode ?? "device"
    // US-670: active workspace context (switcher).
    @State private var workspaceContext: WorkspaceContext?

    // US-1498: /help does NOT exist (not in the web router, public-routes
    // registry, or Pages Functions) — it 404'd in the in-app Safari sheet, a
    // guaranteed App Review reject. /faq is the real route (PublishDialog already
    // links it). Keep this pointed at a route that ships.
    private static let helpURL = URL(string: "https://gradethread.com/faq")!

    /// Every sheet Settings can present, in the order the list offers them.
    enum SettingsSheet: Identifiable {
        case changePassword
        /// US-2671: in-app TOTP enrollment. The workspace 2FA policy blocks a
        /// member on every request, and there was nowhere on-device to fix it.
        case twoFactor
        /// US-667: CSV / Sheets import.
        case csvImport
        /// US-1136: the native support ticket inbox.
        case supportTickets
        case feedback
        case help
        case gradingGuide
        /// US-818: a legal surface App Review expects to find in-app.
        case legal(LegalLink)
        case deleteAccount

        var id: String {
            switch self {
            case .changePassword:    return "changePassword"
            case .twoFactor:         return "twoFactor"
            case .csvImport:         return "csvImport"
            case .supportTickets:    return "supportTickets"
            case .feedback:          return "feedback"
            case .help:              return "help"
            case .gradingGuide:      return "gradingGuide"
            case .legal(let link):   return "legal.\(link.id)"
            case .deleteAccount:     return "deleteAccount"
            }
        }
    }

    /// US-818: legal surfaces App Review expects to find in-app, opened via
    /// ``SafariView``.
    struct LegalLink: Identifiable {
        let id: String
        let title: String
        let url: URL

        static let privacy = LegalLink(
            id: "privacy",
            title: "Privacy Policy",
            url: URL(string: "https://gradethread.com/privacy")!
        )
        static let terms = LegalLink(
            id: "terms",
            title: "Terms of Service",
            url: URL(string: "https://gradethread.com/terms")!
        )
    }

    var body: some View {
        List {
            // ── Account ──────────────────────────────────────────────
            ProfileSection()
            workspaceSection
            PlanSection()
            // US-194: AI Item Assistant (toggle + monthly usage meter + cap),
            // wired to the users row — mirrors US-167 on the web.
            AIAssistantSection()
            // US-2503: the buyer tools bundled with every FlipDesk plan. The
            // plan screen says where each one lives; this is the way into the
            // ones that live here.
            buyerSection
            Section("Account") {
                if case let .signedIn(user) = authStore.phase {
                    LabeledContent("Email", value: user.email ?? "—")
                }
                // US-818: in-app change password (no email round-trip).
                Button {
                    sheet = .changePassword
                } label: {
                    Label("Change password", systemImage: "key")
                }
                .accessibilityLabel("Change password")
                // US-2671: TOTP enrollment on-device. Before this the app told a
                // member blocked by their workspace's 2FA policy to go to
                // gradethread.com, because this row did not exist.
                Button {
                    sheet = .twoFactor
                } label: {
                    Label("Two-factor authentication", systemImage: "lock.shield")
                }
                .accessibilityLabel("Two-factor authentication")
                Button(role: .destructive) {
                    confirmingSignOut = true
                } label: {
                    HStack {
                        Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                        if signingOut { Spacer(); ProgressView() }
                    }
                }
                .disabled(signingOut)
                .confirmationDialog(
                    "Sign out?",
                    isPresented: $confirmingSignOut,
                    titleVisibility: .visible
                ) {
                    Button("Sign out", role: .destructive) {
                        signingOut = true
                        // US-1499: reset the spinner when the call returns. Sign-out
                        // is now local-first (always flips phase to .signedOut, which
                        // tears this view down), but resetting defensively means the
                        // row never sticks on a permanent ProgressView even if the
                        // phase somehow didn't change.
                        Task {
                            await authStore.signOut()
                            signingOut = false
                        }
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("Any changes on this device that haven't synced yet will be cleared.")
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
                    sheet = .csvImport
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
                // US-814: sourcing locations — list with item counts + spend,
                // create/edit/archive, tap-through to filtered inventory.
                NavigationLink {
                    SourcesView()
                } label: {
                    Label("Sources", systemImage: "mappin.and.ellipse")
                }
            } header: {
                Text("Data")
            } footer: {
                Text("Import a catalog from a CSV file or a Google Sheet. Save listing templates so you write the description, condition and policies once. Track consignors and their cut, and record where your stock comes from.")
                    .font(.footnote)
            }

            // ── Preferences ──────────────────────────────────────────
            preferencesSection
            // US-805: usage-alert sensitivity for the soft plan-limit banner.
            UsageAlertThresholdSection()
            // These each render their own Section, so they sit at the top level
            // of the List rather than nested inside another Section.
            realtimeSection
            // US-696: optional Face ID / passcode app lock.
            AppLockToggleSection()
            analyticsSection
            // US-1861: Thrift Radar contribution. Its OWN section, next to but
            // never folded into the analytics one — location is a new kind of
            // data, so it gets a new switch and its own copy.
            RadarContributionSection()

            // ── Notifications ────────────────────────────────────────
            notificationPreferencesSection

            // ── Support ──────────────────────────────────────────────
            Section("Support") {
                // US-1136: native ticket inbox — open a request + read threaded
                // replies in-app instead of only emailing feedback.
                Button {
                    sheet = .supportTickets
                } label: {
                    Label("Support tickets", systemImage: "bubble.left.and.bubble.right")
                }
                .accessibilityLabel("Support tickets")
                Button {
                    sheet = .feedback
                } label: {
                    Label("Send feedback", systemImage: "envelope")
                }
                Button {
                    sheet = .help
                } label: {
                    Label("Help & FAQ", systemImage: "questionmark.circle")
                }
                // US-818: native explainer of the 5 grading factors + tier scale.
                Button {
                    sheet = .gradingGuide
                } label: {
                    Label("How grading works", systemImage: "checkmark.seal")
                }
                .accessibilityLabel("How grading works")
                // US-2875: the web has had both of these in Settings since
                // US-378; iOS set a versioned UserDefaults flag on completion
                // and offered no way to clear it, so a user who skipped the
                // carousel on day one could never see it again. Same wording as
                // the web, pinned by src/test/onboarding-replay-parity.test.ts.
                Button {
                    OnboardingState().replay()
                } label: {
                    Label("Replay tour", systemImage: "sparkles")
                }
                .accessibilityLabel("Replay tour")
                Button {
                    ActivationChecklistStore.undismiss()
                } label: {
                    Label("Setup checklist", systemImage: "checklist")
                }
                .accessibilityLabel("Setup checklist")
            }
            // DiagnosticsSection renders its own Section — keep it top-level.
            DiagnosticsSection()

            // ── Legal (US-818) ───────────────────────────────────────
            Section {
                Button {
                    sheet = .legal(.privacy)
                } label: {
                    Label("Privacy Policy", systemImage: "hand.raised")
                }
                .accessibilityLabel("Privacy Policy")
                Button {
                    sheet = .legal(.terms)
                } label: {
                    Label("Terms of Service", systemImage: "doc.text")
                }
                .accessibilityLabel("Terms of Service")
            } header: {
                Text("Legal")
            } footer: {
                Text("Opens our Privacy Policy and Terms of Service on gradethread.com.")
                    .font(.footnote)
            }

            // ── About ────────────────────────────────────────────────
            Section("About") {
                LabeledContent("Version", value: Self.versionString)
            }

            // ── Danger zone (isolated) ───────────────────────────────
            Section {
                Button(role: .destructive) {
                    sheet = .deleteAccount
                } label: {
                    Label("Delete account", systemImage: "trash")
                }
            } footer: {
                Text("Permanently deletes your account and all associated data. This can't be undone.")
                    .font(.footnote)
            }
        }
        .navigationTitle("Settings")
        .sheet(item: $sheet) { presented in
            switch presented {
            case .changePassword:
                ChangePasswordSheet()
            case .twoFactor:
                TwoFactorSheet()
            case .csvImport:
                CSVImportView()
            case .supportTickets:
                SupportTicketsView()
            case .feedback:
                FeedbackSheet()
            case .help:
                SafariView(url: Self.helpURL).ignoresSafeArea()
            case .gradingGuide:
                GradingGuideSheet()
            case .legal(let link):
                SafariView(url: link.url).ignoresSafeArea()
            case .deleteAccount:
                DeleteAccountSheet()
            }
        }
        .task {
            if workspaceContext == nil, case let .signedIn(user) = authStore.phase {
                let ctx = WorkspaceContext(selfUserId: user.id.uuidString)
                workspaceContext = ctx
                await ctx.load()
            }
        }
    }

    // US-2503: the buyer tools that live in THIS app. One row per shipped
    // capability, and nothing here for a capability that has no screen — the
    // plan screen is where the full bundle is listed with its locations, so a
    // row that opened a "coming soon" page would be the over-promise this
    // story is about, moved rather than fixed.
    private var buyerSection: some View {
        Section("Buyer tools") {
            NavigationLink {
                BuyerAlertsView()
            } label: {
                Label("Condition alerts", systemImage: "bell")
            }
            NavigationLink {
                BuyerTrustScoreView()
            } label: {
                Label("Trust score", systemImage: "rosette")
            }
            // US-2815: the consumer grading path. ConsumerGradeFlow has been
            // complete and unit-tested since US-2016 and presented by nothing —
            // every reference to it in the repo was in its own test file.
            NavigationLink {
                ConsumerGradeView()
            } label: {
                Label("Grade a garment", systemImage: "tshirt")
            }
            NavigationLink {
                BuyerPortfolioView()
            } label: {
                Label("Closet", systemImage: "hanger")
            }
            NavigationLink {
                BuyerGuaranteeView()
            } label: {
                Label("Purchase guarantee", systemImage: "shield")
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
                    // US-1254: ctx.activeOwnerId is already the active workspace
                    // owner; pass selfUserId so the caller's real role is resolved.
                    TeamView(ownerId: ctx.activeOwnerId, selfId: ctx.selfUserId)
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
            .onAppear {
                // US-1259: reflect the injected/AppDelegate-owned service's
                // state so the toggle and the live scheduler agree (not a
                // throwaway read).
                if let service = backgroundRefreshService {
                    bgRefreshEnabled = service.isEnabled
                }
            }
            .onChange(of: bgRefreshEnabled) { _, newValue in
                // US-1259: route through the injected/AppDelegate-owned instance
                // (the one holding the live container + SyncEngine), so the
                // toggle drives the scheduler the BG task actually uses.
                backgroundRefreshService?.isEnabled = newValue
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

/// US-805: usage-alert sensitivity. Picks the cap-usage percentage at which the
/// non-blocking soft banner appears (50 / 80 / 95, mirroring web US-209).
/// UserDefaults-backed via ``AppPreferences``; default 80%.
private struct UsageAlertThresholdSection: View {
    @State private var threshold: UsageAlertThreshold = AppPreferences.usageAlertThreshold

    var body: some View {
        Section {
            Picker(selection: $threshold) {
                ForEach(UsageAlertThreshold.allCases) { option in
                    Text(option.label).tag(option)
                }
            } label: {
                Label("Warn me at", systemImage: "gauge.with.dots.needle.67percent")
            }
            .onChange(of: threshold) { _, newValue in
                AppPreferences.usageAlertThreshold = newValue
            }
        } header: {
            Text("Usage alerts")
        } footer: {
            Text("Show a heads-up banner when you cross this share of a plan limit (active listings, AI actions, monthly grades). You'll always be prompted to upgrade when a limit is reached.")
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
    /// US-2914 AC5: seeded from the CURRENT answer and re-read once the consent
    /// regime settles.
    ///
    /// This used to be the whole story - a single `= Telemetry.isAnalyticsEnabled`
    /// at view construction. That was correct while the answer was a constant
    /// `?? true`. It is not correct now: the regime resolves asynchronously
    /// from a network lookup, so a one-shot read renders whatever was true
    /// before the answer arrived and stays there. On Android that was a real
    /// trap - the toggle showed "off" while analytics came on a moment later,
    /// which is the worst possible direction for a privacy control to lie in.
    @State private var isEnabled: Bool = Telemetry.isAnalyticsEnabled
    /// Guards the write-back. `onChange` cannot tell a user's tap from the
    /// refresh below, and without this the refresh would write the resolved
    /// value into UserDefaults as though the seller had chosen it - turning
    /// "never asked" into an explicit choice they never made, permanently.
    @State private var didResolve = false

    var body: some View {
        Section {
            Toggle(isOn: $isEnabled) {
                Label("Share product analytics", systemImage: "chart.bar.xaxis")
            }
            .onChange(of: isEnabled) { _, newValue in
                guard didResolve else { return }
                Telemetry.isAnalyticsEnabled = newValue
            }
            .task {
                await Telemetry.resolveConsentRegime()
                isEnabled = Telemetry.isAnalyticsEnabled
                didResolve = true
            }
        } header: {
            Text("Analytics")
        } footer: {
            Text("Anonymous usage stats help us see which flows work and which need polish. Turning this off stops product analytics; crash reports still go through so we can fix bugs in your build.")
                .font(.footnote)
        }
    }
}

/// US-1861 — the Thrift Radar contribution switch. DEFAULT OFF.
///
/// The footer is the consent, not a summary of it: it names exactly what a scan
/// shares and at what granularity, because that is what someone is agreeing to
/// when they flip this. Every claim in it is checkable against the server code —
/// the position becomes a ~1 km cell and is discarded, the account is replaced by
/// a weekly-rotating code, and the scan never waits on the write.
///
/// Turning it ON asks for location permission here, beside the explanation,
/// rather than mid-scan where a system prompt reads as a surprise. Turning it
/// OFF stops the next scan contributing; it does not affect viewing Radar, which
/// is a separate choice.
private struct RadarContributionSection: View {
    // Seeded from the nonisolated stored value (the same UserDefaults mirror the
    // scan path reads), then reconciled against the server in `.task`.
    @State private var isEnabled: Bool = RadarConsent.storedContribution()
    @State private var isSaving = false
    @State private var locationBlocked = false
    @State private var errorMessage: String?

    var body: some View {
        Section {
            Toggle(isOn: $isEnabled) {
                Label("Contribute to Thrift Radar", systemImage: "dot.radiowaves.left.and.right")
            }
            .disabled(isSaving)
            .onChange(of: isEnabled) { _, newValue in
                Task { await save(newValue) }
            }

            if isEnabled, locationBlocked {
                Text("Location is off for GradeThread, so scans can't be placed on the map. Turn it on in the Settings app to contribute.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        } header: {
            Text("Thrift Radar")
        } footer: {
            Text("Off unless you turn it on. While it's on, each Prospect scan shares the rough area you're in — rounded to a cell about a kilometre across, with your exact position used to work that out and then thrown away — plus the brand, category, condition band and whether the item looked worth buying. Not your photos and not what you paid. Contributions carry a scrambled code instead of your account, and that code is regenerated every week. Viewing Radar is a separate choice: turning this off doesn't take the map away.")
                .font(.footnote)
        }
        .task {
            await RadarConsent.shared.refresh()
            isEnabled = RadarConsent.shared.isContributing
            refreshLocationBlocked()
        }
    }

    private func refreshLocationBlocked() {
        let provider = RadarLocationProvider.shared
        locationBlocked = provider.hasBeenAsked && !provider.isAuthorized
    }

    private func save(_ next: Bool) async {
        let consent = RadarConsent.shared
        guard next != consent.isContributing else { return }
        errorMessage = nil
        isSaving = true
        defer { isSaving = false }

        // Ask for the permission next to the copy that explains it. Only on the
        // way ON — a revocation must never trigger a prompt.
        if next { RadarLocationProvider.shared.requestAuthorizationIfNeeded() }

        guard let userId = try? await SupabaseShared.client.auth.session.user.id.uuidString else {
            isEnabled = !next
            errorMessage = "Sign in again to change this."
            return
        }
        if let failure = await consent.setContributing(next, userId: userId) {
            // Snap back rather than showing a switch the server disagrees with.
            isEnabled = !next
            errorMessage = failure
        }
        refreshLocationBlocked()
    }
}

/// One toggle per push category. Persists to UserDefaults under a
/// per-category key so the value survives launches. Default ON.
private struct NotificationCategoryToggle: View {
    let category: NotificationCategoryID
    @State private var isEnabled: Bool

    init(category: NotificationCategoryID) {
        self.category = category
        // US-1257: read through the shared store so the toggle, the
        // foreground-presentation delegate, and the local notifiers agree.
        let initial = NotificationPreferences.isEnabled(category)
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
        NotificationPreferences.userDefaultsKey(for: category)
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

// MARK: - Reconcile banner (US-749)

/// Slim, tab-independent affordance shown directly under the sync bar when the
/// eBay sync has left unmatched listings. Mirrors the sync bar's chrome so it
/// reads as a sibling status strip, tinted amber to signal "needs attention".
private struct ReconcileBanner: View {
    let count: Int
    let onTap: () -> Void
    /// US-1262: dismiss/snooze the persistent banner so it isn't a permanent nag.
    let onSnooze: () -> Void

    var body: some View {
        HStack(spacing: Spacing.xs) {
            Button(action: onTap) {
                HStack(spacing: Spacing.xs) {
                    Image(systemName: "arrow.left.arrow.right")
                    Text("\(count) unmatched listing\(count == 1 ? "" : "s") to reconcile")
                        .font(.footnote.weight(.medium))
                    Spacer(minLength: Spacing.xs)
                    Image(systemName: "chevron.right").font(.caption2)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(count) unmatched eBay listing\(count == 1 ? "" : "s") to reconcile")
            .accessibilityHint("Opens reconciliation")

            // US-1262: a small dismiss control snoozes the reminder for a day.
            Button(action: onSnooze) {
                Image(systemName: "xmark")
                    .font(.caption2.weight(.bold))
                    .padding(6)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss reconcile reminder")
            .accessibilityHint("Hides this for a day, or until more unmatched listings appear")
        }
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity)
        .background(Color.brandAmber.opacity(0.15))
        .foregroundStyle(Color.brandAmber)
        .transition(.move(edge: .top).combined(with: .opacity))
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
/// Mirrors the refreshed media kit (vault/20-domain/brand-design-system.md §2 / §4A and the web app's
/// src/index.css) and reads from the asset catalog (US-192) so iOS swaps to the
/// high-contrast variant when Increase Contrast is on in Accessibility Settings.
///
/// `brandNavy` is the Obsidian Navy (#0C1E36) brand anchor. `brandSteelNavy`
/// (#0F3460) is the distinct primary surface navy.
///
/// ⚠ THIS COMMENT USED TO SAY Steel Navy was the Excellent grade tier (7.0–9.0).
/// It is not, as of 2026-09-04: US-3010 AC6 collapsed the grade ladder to three
/// bands and 7.0–9.4 is now emerald on all three clients. `brandSteelNavy` is
/// still live — StatusBadge paints the pipeline phases with it — but nothing in
/// the grade ladder should reach for it again.
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
