import Foundation
import WebKit

/// US-3281 — where a marketplace sign-in lives when the seller signs in inside
/// the app, and how it is erased.
///
/// THE WHOLE FEATURE RESTS ON THIS FILE BEING BORING. GradeThread ends a
/// Poshmark listing by showing the seller Poshmark's own site in a `WKWebView`
/// they signed into themselves. That is only defensible, to Poshmark and to App
/// Review, while the session is exactly what it would be in Safari: cookies on
/// the device, belonging to the person, going nowhere.
/// See `vault/10-ops/ios-webview-delist-app-review.md`.
///
/// So, three rules, and none of them is a preference:
///
///  1. **A persistent, per-marketplace store.** Persistent because asking a
///     seller to sign in to Poshmark every single time is how the feature stops
///     being faster than opening Safari. Per marketplace because a shared store
///     lets one marketplace's page read another's cookies, which is a thing
///     neither of them agreed to.
///  2. **Nothing here is synced, uploaded, or backed up to us.**
///     `WKWebsiteDataStore(forIdentifier:)` keeps its data in the app container
///     on the device. No code in this app reads a cookie out of it, and there is
///     no path from it to `functions.gradethread.com`.
///  3. **Sign-out and account deletion erase every store.** A device handed to
///     someone else must not still be signed in to the previous owner's
///     Poshmark closet. `ContentView.clearAllLocalDataOnSignOut` calls
///     ``removeAll()`` for exactly that reason, and
///     `ios/Scripts/check-web-delist.py` fails the build if that call goes away.
///
/// The identifiers are fixed UUIDs rather than derived from the platform name,
/// because `WKWebsiteDataStore(forIdentifier:)` takes a UUID and a derived one
/// would change the day somebody renamed a platform key, silently orphaning the
/// old store with a live session inside it.
@MainActor
enum WebDelistDataStore {

    /// One fixed identifier per marketplace. Never reuse or re-derive these.
    private static let identifiers: [String: UUID] = [
        "poshmark": UUID(uuidString: "6F3B1C22-0A54-4C2E-9B7E-5B1D1E2A0001") ?? UUID(),
        "mercari": UUID(uuidString: "6F3B1C22-0A54-4C2E-9B7E-5B1D1E2A0002") ?? UUID(),
        "grailed": UUID(uuidString: "6F3B1C22-0A54-4C2E-9B7E-5B1D1E2A0003") ?? UUID(),
        "vinted": UUID(uuidString: "6F3B1C22-0A54-4C2E-9B7E-5B1D1E2A0004") ?? UUID(),
        "facebook": UUID(uuidString: "6F3B1C22-0A54-4C2E-9B7E-5B1D1E2A0005") ?? UUID()
    ]

    /// The store for one marketplace.
    ///
    /// Falls back to a NON-persistent store rather than to the default one. A
    /// fallback to `.default()` would put a marketplace session in the same jar
    /// as everything else the app ever loads in a web view, which is the one
    /// outcome worse than making the seller sign in again.
    static func store(for platform: String) -> WKWebsiteDataStore {
        guard let id = identifiers[platform] else {
            return WKWebsiteDataStore.nonPersistent()
        }
        return WKWebsiteDataStore(forIdentifier: id)
    }

    /// Whether this platform has a store at all. Used by the runner to refuse a
    /// platform it has no session home for, before anything is loaded.
    static func isKnown(_ platform: String) -> Bool {
        identifiers[platform] != nil
    }

    /// Erase every marketplace sign-in on this device.
    ///
    /// Called from Settings ("Clear marketplace sign-ins"), from sign-out, and
    /// from account deletion. Best-effort per store: one failure must not skip
    /// the rest, for the same reason `LocalCacheWipe` deletes each model
    /// independently.
    static func removeAll() async {
        let all = WKWebsiteDataStore.allWebsiteDataTypes()
        let epoch = Date(timeIntervalSince1970: 0)
        for (platform, id) in identifiers {
            let target = WKWebsiteDataStore(forIdentifier: id)
            await target.removeData(ofTypes: all, modifiedSince: epoch)
            Telemetry.backgroundBreadcrumb(
                "cleared marketplace web session: \(platform)",
                category: "marketplaces"
            )
        }
    }
}
