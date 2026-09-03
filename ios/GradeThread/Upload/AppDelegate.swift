import SwiftData
import SwiftUI
import UIKit

/// Bridges UIKit AppDelegate callbacks SwiftUI doesn't surface directly.
///
/// Specifically: when an upload finishes while the app is backgrounded,
/// iOS launches us into the background to process the completion. The
/// system delivers the original completion handler via
/// `application(_:handleEventsForBackgroundURLSession:completionHandler:)`
/// and expects us to call it back once any in-flight DB writes are done.
///
/// SwiftUI's @main App doesn't expose that callback, so we plug in a
/// classic AppDelegate via @UIApplicationDelegateAdaptor in `App.swift`.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {

    /// US-2338: the SwiftData store, built here rather than in ``GradeThreadApp``.
    ///
    /// It moved because ``photoUploadService`` needs the container AT
    /// CONSTRUCTION, and the delegate is the earliest thing in the launch path
    /// that can hold both. `GradeThreadApp` reads it back through
    /// `appDelegate.storeOutcome` (a computed property can reference `self`,
    /// which is exactly what a stored property could not do — the reason the
    /// service was constructed container-less in the first place).
    ///
    /// ``ModelStoreProvider.load()`` is pure and depends on nothing from
    /// UIApplication, so running it at delegate-init is equivalent to running it
    /// at App-init; only the owner changed.
    let storeOutcome: ModelStoreProvider.LoadOutcome = ModelStoreProvider.load()

    /// One service per app launch. Owned here so it outlives view churn
    /// and stays bound to the same background-URLSession identifier as
    /// the system re-creates it across launches.
    let photoUploadStore = PhotoUploadStore()
    /// US-2338: built WITH the container. This was
    /// `PhotoUploadService(store: photoUploadStore)` — no container — and the
    /// service's three `guard let container = modelContainer else { return }`
    /// sites then silently discarded every queued upload retry and returned an
    /// empty pending list, so a failed upload was neither retried nor visible.
    /// The parameter is now non-optional, so that wiring mistake is a compile
    /// error rather than three quiet no-ops.
    lazy var photoUploadService = PhotoUploadService(
        store: photoUploadStore,
        modelContainer: storeOutcome.container
    )

    /// Background App Refresh (US-188). Initialized lazily so the
    /// ModelContainer the service uses can be injected after the App
    /// scene constructs it.
    let backgroundRefresh = BackgroundRefreshService()

    /// US-187 push delegate. Held on the AppDelegate because
    /// `UNUserNotificationCenter.delegate` is a weak reference — drop
    /// the strong reference and the delegate vanishes mid-launch.
    let pushNotificationDelegate = NotificationDelegate()

    /// US-1405: StoreKit transaction listener (renewals, refunds, deferred /
    /// Ask-to-Buy approvals, interrupted purchases the App Store completes on a
    /// later launch). Held so the detached task isn't cancelled, and started in
    /// `didFinishLaunchingWithOptions` — BEFORE any awaited warm-up — so a
    /// transaction resolved during launch is never delivered to
    /// `Transaction.updates` before a listener is attached (which would leave the
    /// user charged-but-not-entitled).
    private var storeKitListener: Task<Void, Never>?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Touch the lazy var so the background URLSession reattaches
        // immediately on launch. Without this, the system may deliver
        // completion events before any view code has created the session,
        // and we'd lose them.
        _ = photoUploadService

        // US-1405: attach the StoreKit transaction listener immediately on
        // launch, before any awaited warm-up, per Apple's guidance. Same
        // motivation as the upload session above — a transaction the system
        // resolves during launch must not be delivered to `Transaction.updates`
        // before we're listening, or the user is charged without entitlement.
        storeKitListener = StoreKitService.startTransactionListener()

        // Register the BG refresh task at launch — iOS rejects late
        // registration with a console warning. The handler runs through
        // SyncEngine.sync() via the .inventoryPullRequested notification
        // ContentView already listens for.
        backgroundRefresh.register()

        // US-191 telemetry. Idempotent — Sentry + PostHog start once
        // per process. Missing DSN/key disables silently.
        Telemetry.bootstrap()

        // Hook the push delegate + register notification categories.
        // We don't request notification *permission* here per the AC —
        // that's deferred until first Sales tab visit.
        UNUserNotificationCenter.current().delegate = pushNotificationDelegate
        Task { @MainActor in
            await NotificationCategories.registerAll()
        }
        return true
    }

    // MARK: - Remote notifications

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in
            PushService.shared.handleDeviceToken(deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        Task { @MainActor in
            PushService.shared.handleRegistrationError(error)
        }
    }

    /// US-3101: a long-press on the app icon.
    ///
    /// Handled on the delegate rather than a scene delegate because this app
    /// has no scene delegate — SwiftUI owns the scene, and this adaptor is the
    /// only UIKit seam. `HomeScreenShortcut.handle` posts through
    /// ``DeepLinkRouter``, which is what makes a shortcut that COLD-LAUNCHES
    /// the app work: the route is held until the SwiftUI layer subscribes and
    /// ContentView drains it (US-1410), rather than being posted into a bus
    /// nothing is listening to yet.
    func application(
        _ application: UIApplication,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        completionHandler(HomeScreenShortcut.handle(shortcutItem))
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Schedule the next BG refresh whenever the user backgrounds the
        // app. The system uses this as a hint; real cadence is up to
        // iOS heuristics.
        backgroundRefresh.scheduleNext()
    }

    /// iOS calls this when the app is woken to finish processing a
    /// background URLSession transfer. Hand the completion through to the
    /// service; it invokes the closure after the post-upload DB writes
    /// drain.
    func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        guard identifier == PhotoUploadService.backgroundSessionIdentifier else {
            // Unknown session identifier — call the completion anyway so
            // the OS doesn't hang on us. Any other identifier would mean
            // we've accidentally registered a second background session.
            completionHandler()
            return
        }
        Task { @MainActor in
            photoUploadService.handleBackgroundEvents(completion: completionHandler)
        }
    }
}
