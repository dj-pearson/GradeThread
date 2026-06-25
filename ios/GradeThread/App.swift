import SwiftData
import SwiftUI

@main
struct GradeThreadApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    /// SwiftData store backing the offline cache. Created eagerly at app
    /// launch so views can synchronously query the cache before the first
    /// sync pass finishes.
    ///
    /// US-987: built via ``ModelStoreProvider`` so a corrupt store recovers
    /// (delete + recreate, falling back to in-memory) instead of `fatalError`-ing
    /// the app into an unrecoverable relaunch loop. The outcome carries whether
    /// the local cache had to be reset so we can show a one-time notice.
    private let storeOutcome: ModelStoreProvider.LoadOutcome = ModelStoreProvider.load()

    private var container: ModelContainer { storeOutcome.container }

    init() {
        // US-1153: hermetic UI-test launch. Wipe the keychain BEFORE anything
        // touches `SupabaseShared.client` (its session is loaded lazily from the
        // keychain on first access in `AuthStore.start`), so a `-uitest-reset-auth`
        // run always begins signed-out at `LoginView`. No-op in production —
        // `resetAuthState` requires the runner-injected launch arguments.
        if UITestSupport.resetAuthState {
            try? KeychainLocalStorage().removeAll()
        }
    }

    /// Per-category photo-profile table (server-authoritative, cached). Created
    /// once and shared so the capture + retag surfaces resolve a category's
    /// photo slots without each refetching. See PhotoProfileStore.
    @State private var photoProfileStore = PhotoProfileStore()

    /// US-987: drives the one-time "local data was reset" notice when launch had
    /// to discard a corrupt cache. Set from `storeOutcome` once the scene is up.
    @State private var showingStoreResetNotice = false

    /// US-1142: surfaces a one-time notice when local writes are *persistently*
    /// failing (disk full, store corruption). `saveOrLog` posts on every failed
    /// save; we count them and only nag once a few have piled up so a single
    /// transient blip stays quiet.
    @State private var showingSaveFailureNotice = false
    @State private var saveFailureCount = 0

    var body: some Scene {
        WindowGroup {
            ContentView()
                .modelContainer(container)
                .environment(appDelegate.photoUploadStore)
                .environment(photoProfileStore)
                .environment(\.photoUploadService, appDelegate.photoUploadService)
                // US-984: expose the shared background-refresh service so
                // ContentView can hand it the live SyncEngine once it's built.
                .environment(\.backgroundRefreshService, appDelegate.backgroundRefresh)
                // Hand the background-refresh service the live container so
                // its new-sale / new-grade detection can read the cache.
                .task {
                    appDelegate.backgroundRefresh.attachModelContainer(container)
                    // Warm the photo-profile cache so retag/capture have the
                    // category-specific slots ready (falls back to bundled).
                    await photoProfileStore.loadIfNeeded()
                    // Drain StoreKit transaction updates (renewals/refunds/
                    // deferred buys): report + finish each. Detached, lives on.
                    _ = StoreKitService.startTransactionListener()
                    // US-987: if the on-disk cache was corrupt and we recovered,
                    // record it for diagnostics + surface a one-time notice so
                    // the user understands why their local data looks empty until
                    // the next sync repopulates it.
                    if storeOutcome.didResetStore {
                        Telemetry.breadcrumb(
                            storeOutcome.isInMemoryFallback
                                ? "SwiftData store recovery fell back to in-memory"
                                : "SwiftData store reset after corruption",
                            category: "persistence"
                        )
                        showingStoreResetNotice = true
                    }
                }
                .alert(
                    "Local data was reset",
                    isPresented: $showingStoreResetNotice
                ) {
                    Button("OK", role: .cancel) {}
                } message: {
                    Text(storeResetMessage)
                }
                // US-1142: persistent local-save failures. Debounced to the
                // main run loop because `saveOrLog` posts from whatever isolation
                // the failing context lives in (the SyncMergeActor, a background
                // upload context, etc.).
                .onReceive(
                    NotificationCenter.default
                        .publisher(for: PersistenceHealth.saveFailedNotification)
                        .receive(on: RunLoop.main)
                ) { _ in
                    saveFailureCount += 1
                    if saveFailureCount >= 3 { showingSaveFailureNotice = true }
                }
                .alert(
                    "Couldn't save changes on this device",
                    isPresented: $showingSaveFailureNotice
                ) {
                    Button("OK", role: .cancel) { saveFailureCount = 0 }
                } message: {
                    Text("GradeThread is having trouble saving changes locally — this device may be low on storage. Your account and synced data on our servers are safe. Free up space, then restart the app.")
                }
        }
    }

    /// Copy for the recovery notice. The in-memory case is more severe (the
    /// cache won't survive the next launch), so it gets a distinct message.
    private var storeResetMessage: String {
        if storeOutcome.isInMemoryFallback {
            return "We couldn't repair this device's offline cache, so GradeThread is running without one for now. Your account and data on our servers are safe and will sync back in. Any changes you made while offline and hadn't synced yet may be lost. Restarting the app may restore offline storage."
        }
        return "GradeThread's offline cache was damaged and had to be cleared. Your account and data on our servers are safe — they'll sync back to this device automatically. Any changes you made while offline and hadn't synced yet may be lost."
    }
}

// MARK: - Environment key

private struct PhotoUploadServiceKey: EnvironmentKey {
    // nil-default is trivially Sendable; the actual reference (set in
    // ContentView's environment) is @MainActor and only ever read from
    // MainActor-isolated views, so the cross-actor concern is moot.
    static let defaultValue: PhotoUploadService? = nil
}

private struct BackgroundRefreshServiceKey: EnvironmentKey {
    // nil-default for previews; the real instance is the AppDelegate-owned one
    // and is only read from MainActor-isolated views.
    static let defaultValue: BackgroundRefreshService? = nil
}

extension EnvironmentValues {
    /// Injected via the AppDelegate so the same service instance is
    /// available everywhere without a global singleton. nil during
    /// previews — the calling view should branch on availability rather
    /// than force-unwrapping.
    var photoUploadService: PhotoUploadService? {
        get { self[PhotoUploadServiceKey.self] }
        set { self[PhotoUploadServiceKey.self] = newValue }
    }

    /// US-984: the AppDelegate-owned ``BackgroundRefreshService`` so ContentView
    /// can attach the live SyncEngine to it when sign-in builds the engine.
    var backgroundRefreshService: BackgroundRefreshService? {
        get { self[BackgroundRefreshServiceKey.self] }
        set { self[BackgroundRefreshServiceKey.self] = newValue }
    }
}
