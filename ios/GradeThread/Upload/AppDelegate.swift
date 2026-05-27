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

    /// One service per app launch. Owned here so it outlives view churn
    /// and stays bound to the same background-URLSession identifier as
    /// the system re-creates it across launches.
    let photoUploadStore = PhotoUploadStore()
    lazy var photoUploadService = PhotoUploadService(store: photoUploadStore)

    /// Background App Refresh (US-188). Initialized lazily so the
    /// ModelContainer the service uses can be injected after the App
    /// scene constructs it.
    let backgroundRefresh = BackgroundRefreshService()

    /// US-187 push delegate. Held on the AppDelegate because
    /// `UNUserNotificationCenter.delegate` is a weak reference — drop
    /// the strong reference and the delegate vanishes mid-launch.
    let pushNotificationDelegate = NotificationDelegate()

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Touch the lazy var so the background URLSession reattaches
        // immediately on launch. Without this, the system may deliver
        // completion events before any view code has created the session,
        // and we'd lose them.
        _ = photoUploadService

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
