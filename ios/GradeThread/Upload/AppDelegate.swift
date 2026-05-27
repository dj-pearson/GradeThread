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

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Touch the lazy var so the background URLSession reattaches
        // immediately on launch. Without this, the system may deliver
        // completion events before any view code has created the session,
        // and we'd lose them.
        _ = photoUploadService
        return true
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
